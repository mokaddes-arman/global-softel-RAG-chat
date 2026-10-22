'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { query, withTransaction } = require('../db');
const { config } = require('../config/env');
const { logger } = require('../lib/logger');
const { AppError, Codes } = require('../lib/errors');
const { newId } = require('../lib/ids');
const storage = require('../lib/storage');
const { sha256 } = require('../lib/ids');
const documents = require('../services/documents');
const { fetchUrl } = require('./fetcher');
const { htmlToMarkdown } = require('./markdown');

/**
 * The crawl pipeline.
 *
 * A crawl job fetches one URL, converts the page to Markdown and stores it as
 * a normal document version, so the page is retrieved, cited and versioned
 * exactly like an uploaded file. A re-crawl adds a new version and keeps the
 * old one (immutable history), which is what makes citations verifiable.
 */

/** Turn a URL into a safe, human-readable file name. */
function filenameForUrl(url, title) {
  const host = url.hostname.replace(/^www\./, '');
  const slug = String(url.pathname || '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const base = slug ? `${host}-${slug}` : host;
  const stem = title ? `${base}-${String(title).slice(0, 40)}` : base;
  return storage.sanitiseFilename(`${stem}.md`, 'web-page.md');
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
  await query(`UPDATE crawl_jobs SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

async function loadJobContext(jobId) {
  const { rows } = await query(
    `SELECT j.*, l.url, l.canonical_url, l.document_id AS linked_document_id, l.title AS link_title,
            l.collection_id, l.link_list_id, p.name AS project_name
     FROM crawl_jobs j
     JOIN web_links l ON l.id = j.web_link_id
     JOIN projects p ON p.id = j.project_id
     WHERE j.id = $1`,
    [jobId],
  );
  return rows[0] || null;
}

/** Errors that will never succeed on a retry (bad URL, refused host...). */
function isPermanentError(code) {
  return [Codes.UNSAFE_URL, Codes.VALIDATION, Codes.FILE_TOO_LARGE].includes(code);
}

async function markFailed(ctx, error) {
  const code = error.code || 'crawl_failed';
  const message = String(error.message || error).slice(0, 2000);
  const attempts = (ctx.attempts || 0) + 1;
  const canRetry = attempts < (ctx.max_attempts || config.crawl.maxAttempts) && !isPermanentError(code);

  try {
    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE crawl_jobs SET status = $2, stage = 'failed', error = $3, error_code = $4, attempts = $5, finished_at = now()
         WHERE id = $1`,
        [ctx.id, canRetry ? 'queued' : 'failed', message, code, attempts],
      );
      await tx.query(
        `UPDATE web_links SET status = 'failed', last_error = $2 WHERE id = $1 AND status <> 'archived'`,
        [ctx.web_link_id, message],
      );
    });
  } catch (err) {
    logger.error({ err: err.message, jobId: ctx.id }, 'could not record the crawl failure');
    await query(
      `UPDATE crawl_jobs SET status = $2, stage = 'failed', error = $3, error_code = $4, attempts = $5, finished_at = now()
       WHERE id = $1`,
      [ctx.id, canRetry ? 'queued' : 'failed', message, code, attempts],
    ).catch(() => {});
    await query(`UPDATE web_links SET status = 'failed', last_error = $2 WHERE id = $1`, [ctx.web_link_id, message]).catch(() => {});
  }

  logger.error({ jobId: ctx.id, code, attempts, canRetry, err: message }, 'crawl job failed');
  return { ok: false, code, message, retryScheduled: canRetry, attempts };
}

/**
 * Store the crawled markdown as a document version.
 *
 * A first crawl creates the document; a re-crawl adds a new version to the
 * existing document so the previous content stays available.
 */
async function storeMarkdown(ctx, { markdown, title, filename }) {
  const tmpPath = path.join(config.paths.tmp, `${newId()}.md`);
  await fsp.writeFile(tmpPath, markdown, 'utf8');
  const size = Buffer.byteLength(markdown, 'utf8');

  try {
    const registered = await documents.registerUpload({
      projectId: ctx.project_id,
      file: {
        path: tmpPath,
        originalname: filename,
        size,
        mimetype: 'text/markdown',
      },
      // A crawled page is always its own document; two different URLs may
      // legitimately serve identical content.
      onDuplicate: 'new_document',
      documentId: ctx.linked_document_id || undefined,
      title: title || ctx.link_title || ctx.url,
    });
    return registered;
  } finally {
    // registerUpload() moves the file into storage; only clean up when it
    // is still sitting in the temp directory.
    await fsp.unlink(tmpPath).catch(() => {});
  }
}

async function processCrawlJob(jobId) {
  const ctx = await loadJobContext(jobId);
  if (!ctx) {
    logger.warn({ jobId }, 'crawl job disappeared before processing');
    return { ok: false, code: 'not_found' };
  }
  if (ctx.status === 'cancelled' || ctx.status === 'completed') {
    return { ok: false, code: 'skipped', message: `job is ${ctx.status}` };
  }

  const started = Date.now();

  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE crawl_jobs SET status = 'processing', stage = 'fetching', progress = 10, started_at = COALESCE(started_at, now()), error = NULL, error_code = NULL
       WHERE id = $1`,
      [jobId],
    );
    await tx.query(`UPDATE web_links SET status = 'crawling', last_error = NULL WHERE id = $1 AND status <> 'archived'`, [ctx.web_link_id]);
  });

  try {
    // 1. Fetch the page.
    const fetched = await fetchUrl(ctx.url);
    await updateJob(jobId, { stage: 'converting', progress: 45, metrics: { bytes: fetched.body.length, contentType: fetched.contentType } });

    // 2. Convert to Markdown.
    const { title, markdown } = htmlToMarkdown(fetched.body);
    const body = markdown.trim();
    if (!body) {
      throw new AppError('The page did not contain any readable text.', {
        code: Codes.PARSE_FAILED,
        status: 422,
      });
    }

    // 3. Store it as a document version and queue the normal ingestion.
    const filename = filenameForUrl(new URL(fetched.finalUrl), title);
    const contentHash = sha256(Buffer.from(body, 'utf8'));
    const registered = await storeMarkdown(ctx, { markdown: body, title, filename });

    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE web_links
            SET document_id = $2, content_hash = $3, crawl_count = crawl_count + 1,
                last_crawled_at = now(), last_error = NULL,
                title = COALESCE($4, title), status = 'pending'
          WHERE id = $1`,
        [ctx.web_link_id, registered.documentId, contentHash, title || null],
      );
    });

    await updateJob(jobId, {
      status: 'completed',
      stage: 'completed',
      progress: 100,
      finished_at: new Date(),
      metrics: {
        bytes: fetched.body.length,
        characters: body.length,
        contentType: fetched.contentType,
        contentHash,
        documentId: registered.documentId,
        versionNumber: registered.versionNumber,
        ingestionJobId: registered.jobId,
        totalMs: Date.now() - started,
      },
    });

    logger.info({ jobId, documentId: registered.documentId, ms: Date.now() - started }, 'crawl completed');
    return { ok: true, documentId: registered.documentId, metrics: { characters: body.length } };
  } catch (err) {
    return markFailed(ctx, err);
  }
}

module.exports = { processCrawlJob, filenameForUrl };
