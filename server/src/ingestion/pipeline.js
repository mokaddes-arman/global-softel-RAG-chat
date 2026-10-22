'use strict';

const { query, withTransaction } = require('../db');
const { config } = require('../config/env');
const { logger } = require('../lib/logger');
const { AppError, Codes } = require('../lib/errors');
const { estimateTokens } = require('../lib/ids');
const storage = require('../lib/storage');
const parsers = require('./parsers');
const { chunkDocument } = require('./chunker');
const { embedTexts } = require('../embeddings');
const { resolveActiveEmbedding } = require('../services/embeddings');

/**
 * The ingestion pipeline.
 *
 * Runs in the background, is idempotent (chunks for a version are fully
 * replaced on each attempt) and records progress/errors for the UI. A failed
 * attempt never leaves half-written chunks because the replace happens inside a
 * single transaction.
 */

const EMBED_BATCH_SIZE = 32;

/**
 * Reject when `promise` does not settle within `ms`. A parser or embedding
 * call that never returns would otherwise leave the job stuck in
 * "processing" forever.
 */
async function withTimeout(promise, ms, label, { code = Codes.PARSE_FAILED, status = 504 } = {}) {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return Promise.resolve(promise);
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AppError(`${label} timed out after ${Math.round(ms / 1000)}s.`, { code, status }));
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function updateJob(jobId, patch) {
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === 'metrics') sets.push(`metrics = $${params.push(JSON.stringify(v))}::jsonb`);
    else sets.push(`${k} = $${params.push(v)}`);
  }
  if (!sets.length) return;
  params.push(jobId);
  await query(`UPDATE ingestion_jobs SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

async function loadJobContext(jobId) {
  const { rows } = await query(
    `SELECT j.*, v.storage_path, v.original_filename, v.file_ext, v.mime_type, v.version_number,
            d.title AS document_title, d.current_version_id, p.name AS project_name
     FROM ingestion_jobs j
     JOIN document_versions v ON v.id = j.document_version_id
     JOIN documents d ON d.id = j.document_id
     JOIN projects p ON p.id = j.project_id
     WHERE j.id = $1`,
    [jobId],
  );
  return rows[0] || null;
}

async function markFailed(ctx, error) {
  const code = error.code || 'ingestion_failed';
  const message = String(error.message || error).slice(0, 2000);
  const attempts = (ctx.attempts || 0) + 1;
  const canRetry = attempts < (ctx.max_attempts || config.ingestionMaxAttempts) && !isPermanentError(code);

  try {
    await withTransaction(async (tx) => {
      await tx.query(`UPDATE document_versions SET status = 'failed', error = $2 WHERE id = $1`, [ctx.document_version_id, message]);
      // Only the document's current version drives the document-level status.
      await tx.query(
        `UPDATE documents SET status = 'failed', last_error = $2 WHERE id = $1 AND current_version_id = $3`,
        [ctx.document_id, message, ctx.document_version_id],
      );
      await tx.query(
        `UPDATE ingestion_jobs
         SET status = $2, stage = 'failed', error = $3, error_code = $4, attempts = $5, finished_at = now()
         WHERE id = $1`,
        [ctx.id, canRetry ? 'queued' : 'failed', message, code, attempts],
      );
    });
  } catch (err) {
    // Recording the failure must never fail: a job that cannot be updated
    // stays "processing" forever and blocks the whole queue. Fall back to
    // plain statements so the job always leaves the "processing" state.
    logger.error({ err: err.message, jobId: ctx.id }, 'could not record the ingestion failure in one transaction');
    await query(
      `UPDATE ingestion_jobs
       SET status = $2, stage = 'failed', error = $3, error_code = $4, attempts = $5, finished_at = now()
       WHERE id = $1`,
      [ctx.id, canRetry ? 'queued' : 'failed', message, code, attempts],
    ).catch((e) => logger.error({ err: e.message, jobId: ctx.id }, 'could not mark the ingestion job as failed'));
    await query(`UPDATE document_versions SET status = 'failed', error = $2 WHERE id = $1`, [ctx.document_version_id, message]).catch(
      () => {},
    );
    await query(
      `UPDATE documents SET status = 'failed', last_error = $2 WHERE id = $1 AND current_version_id = $3`,
      [ctx.document_id, message, ctx.document_version_id],
    ).catch(() => {});
  }

  logger.error({ jobId: ctx.id, code, attempts, canRetry, err: message }, 'ingestion job failed');
  return { ok: false, code, message, retryScheduled: canRetry, attempts };
}

// Errors that will never succeed on retry (bad file, unsupported format...).
function isPermanentError(code) {
  return [
    Codes.UNSUPPORTED_FORMAT,
    Codes.ENCRYPTED_DOCUMENT,
    Codes.PARSE_FAILED,
    Codes.OCR_REQUIRED,
    Codes.FILE_TOO_LARGE,
    Codes.EMBEDDING_DIM_MISMATCH,
  ].includes(code);
}

async function processJob(jobId) {
  const ctx = await loadJobContext(jobId);
  if (!ctx) {
    logger.warn({ jobId }, 'job disappeared before processing');
    return { ok: false, code: 'not_found' };
  }
  if (ctx.status === 'cancelled' || ctx.status === 'completed') {
    return { ok: false, code: 'skipped', message: `job is ${ctx.status}` };
  }

  const started = Date.now();
  const deadline = started + config.ingestionJobTimeoutMs;
  /** Milliseconds left before the whole job must be abandoned. */
  const remaining = () => deadline - Date.now();

  await withTransaction(async (tx) => {
    await tx.query(`UPDATE ingestion_jobs SET status = 'processing', stage = 'reading', progress = 5, started_at = COALESCE(started_at, now()), error = NULL WHERE id = $1`, [jobId]);
    await tx.query(`UPDATE document_versions SET status = 'processing', error = NULL WHERE id = $1`, [ctx.document_version_id]);
    await tx.query(`UPDATE documents SET status = 'processing', last_error = NULL WHERE id = $1 AND current_version_id = $2`, [
      ctx.document_id,
      ctx.document_version_id,
    ]);
  });

  try {
    // 1. Read the original file (path always re-validated against storage root).
    if (!storage.fileExists(ctx.storage_path)) {
      throw new AppError('The stored file for this version is missing from disk. Re-upload the document.', {
        code: Codes.PARSE_FAILED,
        status: 410,
      });
    }
    const buffer = await storage.readStoredFile(ctx.storage_path, config.maxUploadSizeMb * 1024 * 1024);
    await updateJob(jobId, { stage: 'parsing', progress: 15 });

    // 2. Parse with the format-specific parser.
    const parserEntry = parsers.getParser(ctx.file_ext);
    if (!parserEntry) {
      throw new AppError(parsers.unsupportedReason(ctx.file_ext), { code: Codes.UNSUPPORTED_FORMAT, status: 415 });
    }
    const parseStart = Date.now();
    const parsed = await withTimeout(
      parserEntry.parser(buffer, {
        extension: ctx.file_ext,
        mimeType: ctx.mime_type,
        filename: ctx.original_filename,
      }),
      Math.min(config.ingestionParseTimeoutMs, remaining()),
      `Parsing "${ctx.original_filename}"`,
    );
    const parseMs = Date.now() - parseStart;

    const hasText = (parsed.blocks || []).some((b) => b.text && b.text.trim());
    if (!hasText) {
      throw new AppError(
        parsed.ocrLikely
          ? 'No selectable text was found in this file, so it needs OCR before it can be indexed. See README > Scanned PDFs.'
          : 'No extractable text was found in this file. It may be empty, image-only, or corrupt.',
        { code: parsed.ocrLikely ? Codes.OCR_REQUIRED : Codes.PARSE_FAILED, status: 422 },
      );
    }

    await updateJob(jobId, { stage: 'chunking', progress: 30, metrics: { parseMs, blockCount: parsed.blocks.length } });

    // 3. Structure-aware chunking.
    const chunks = chunkDocument(parsed, {
      chunkSizeChars: config.chunkSizeChars,
      chunkOverlapChars: config.chunkOverlapChars,
    });
    if (!chunks.length) {
      throw new AppError('Chunking produced no usable text for embedding.', { code: Codes.PARSE_FAILED, status: 422 });
    }

    // 4. Resolve the active embedding model and embed in batches.
    const embedding = await resolveActiveEmbedding();
    await updateJob(jobId, { stage: 'embedding', progress: 40, metrics: { parseMs, blockCount: parsed.blocks.length, chunkCount: chunks.length } });

    const vectors = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const batchVectors = await withTimeout(
        embedTexts({ ...embedding }, batch.map((c) => c.content)),
        remaining(),
        `Embedding chunks ${i + 1}-${Math.min(i + EMBED_BATCH_SIZE, chunks.length)}`,
        { code: Codes.EMBEDDING_UNAVAILABLE },
      );
      vectors.push(...batchVectors);
      const pct = 40 + Math.round((40 * Math.min(i + EMBED_BATCH_SIZE, chunks.length)) / chunks.length);
      await updateJob(jobId, { progress: Math.min(pct, 80) });
    }
    if (vectors.length !== chunks.length) {
      throw new AppError('Embedding count did not match chunk count.', { code: Codes.EMBEDDING_UNAVAILABLE, status: 500 });
    }

    await updateJob(jobId, { stage: 'storing', progress: 85 });

    // 5. Replace chunks atomically (idempotent retries, no duplicates).
    const totalTokens = chunks.reduce((a, c) => a + c.tokenCount, 0);
    await withTransaction(async (tx) => {
      await tx.query('DELETE FROM document_chunks WHERE document_version_id = $1', [ctx.document_version_id]);

      // Insert in batches to keep the parameter count manageable.
      const INSERT_BATCH = 50;
      for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
        const slice = chunks.slice(i, i + INSERT_BATCH);
        const values = [];
        const params = [];
        for (const c of slice) {
          const vec = `[${vectors[c.index].map((v) => Number(v.toFixed(6))).join(',')}]`;
          const base = params.length;
          params.push(
            ctx.project_id,
            ctx.document_id,
            ctx.document_version_id,
            c.index,
            c.content,
            c.tokenCount,
            c.charCount,
            vec,
            embedding.modelId,
            JSON.stringify(c.metadata),
          );
          values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8}::vector,$${base + 9},$${base + 10}::jsonb)`);
        }
        await tx.query(
          `INSERT INTO document_chunks
             (project_id, document_id, document_version_id, chunk_index, content, token_count, char_count, embedding, embedding_model_id, metadata)
           VALUES ${values.join(',')}`,
          params,
        );
      }

      await tx.query(
        `UPDATE document_versions
         SET status = 'indexed', chunk_count = $2, token_count = $3, page_count = $4, parser = $5,
             source_metadata = $6::jsonb, indexed_at = now(), error = NULL, embedding_model_id = $7
         WHERE id = $1`,
        [
          ctx.document_version_id,
          chunks.length,
          totalTokens,
          parsed.metadata?.pageCount ?? parsed.metadata?.slideCount ?? null,
          parserEntry.label,
          JSON.stringify({ ...parsed.metadata, warnings: parsed.warnings || [] }),
          embedding.modelId,
        ],
      );

      // Only the current version controls document-level status.
      await tx.query(
        `UPDATE documents SET status = 'indexed', last_error = NULL WHERE id = $1 AND current_version_id = $2`,
        [ctx.document_id, ctx.document_version_id],
      );
    });

    const metrics = {
      parseMs,
      embedMs: Date.now() - started - parseMs,
      totalMs: Date.now() - started,
      chunkCount: chunks.length,
      tokenCount: totalTokens,
      embeddingModel: `${embedding.provider}:${embedding.model}`,
      warnings: parsed.warnings || [],
      ocrLikely: Boolean(parsed.ocrLikely),
    };
    await updateJob(jobId, { status: 'completed', stage: 'completed', progress: 100, finished_at: new Date(), metrics });

    // A crawled web page is indexed through this very pipeline, so the link
    // is marked as indexed only once its chunks really exist.
    await query(`UPDATE web_links SET status = 'indexed', last_error = NULL WHERE document_id = $1 AND status <> 'archived'`, [
      ctx.document_id,
    ]).catch(() => {});

    logger.info({ jobId, chunks: chunks.length, totalMs: metrics.totalMs }, 'ingestion completed');
    return { ok: true, chunkCount: chunks.length, metrics };
  } catch (err) {
    return markFailed(ctx, err);
  }
}

/** Index a version directly (used by tests and the re-index path). */
async function ingestVersionNow(versionId) {
  const { rows } = await query('SELECT id FROM ingestion_jobs WHERE document_version_id = $1 ORDER BY created_at DESC LIMIT 1', [versionId]);
  if (!rows[0]) throw new AppError('No ingestion job found for that version.', { code: Codes.NOT_FOUND, status: 404 });
  return processJob(rows[0].id);
}

module.exports = { processJob, ingestVersionNow, EMBED_BATCH_SIZE, estimateTokens };
