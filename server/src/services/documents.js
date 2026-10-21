'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { query, withTransaction } = require('../db');
const { config } = require('../config/env');
const { AppError, Codes } = require('../lib/errors');
const { newId } = require('../lib/ids');
const storage = require('../lib/storage');
const parsers = require('../ingestion/parsers');
const { normaliseExt } = require('../ingestion/parsers/util');

/**
 * Document lifecycle: store an upload safely, detect duplicates by content
 * hash, create versions, and queue ingestion. Files always live on the
 * filesystem; the database only keeps relative paths.
 */

const DUPLICATE_ACTIONS = new Set(['skip', 'new_version', 'new_document']);

function assertExtensionSupported(ext, filename) {
  if (!parsers.isSupported(ext)) {
    throw new AppError(parsers.unsupportedReason(ext) + ` (file: ${filename})`, {
      code: Codes.UNSUPPORTED_FORMAT,
      status: 415,
      details: { extension: ext, supported: parsers.supportedExtensions() },
    });
  }
}

/** Validate a freshly-uploaded temp file and return its metadata. */
async function inspectTempFile(tempPath, originalFilename) {
  const ext = normaliseExt(path.extname(originalFilename));
  assertExtensionSupported(ext, originalFilename);
  const size = await storage.statSize(tempPath);
  if (size === 0) {
    throw new AppError(`"${originalFilename}" is empty (0 bytes) and cannot be indexed.`, {
      code: Codes.BAD_REQUEST,
      status: 400,
    });
  }
  const sha256 = await storage.computeFileHash(tempPath);
  return { ext, size, sha256 };
}

async function findVersionsByHash(projectId, sha256) {
  const { rows } = await query(
    `SELECT v.id AS version_id, v.document_id, v.status, v.version_number, v.is_active, d.title, d.archived
     FROM document_versions v
     JOIN documents d ON d.id = v.document_id
     WHERE v.project_id = $1 AND v.sha256 = $2
     ORDER BY v.version_number DESC`,
    [projectId, sha256],
  );
  return rows;
}

function duplicateError(existing, filename) {
  return new AppError(
    `"${filename}" is identical (byte-for-byte) to an existing document "${existing.title}" ` +
      `(version ${existing.version_number}). Choose how to handle it: skip, upload as a new version, or keep as a separate document.`,
    {
      code: Codes.DUPLICATE_DOCUMENT,
      status: 409,
      details: {
        existingDocumentId: existing.document_id,
        existingVersionId: existing.version_id,
        existingTitle: existing.title,
        existingVersionNumber: existing.version_number,
        existingStatus: existing.status,
        options: ['skip', 'new_version', 'new_document'],
      },
    },
  );
}

/**
 * Register an uploaded file.
 *
 * @param {object} p
 * @param {string} p.projectId
 * @param {{path:string, originalname:string, size:number, mimetype:string}} p.file
 * @param {'skip'|'new_version'|'new_document'} [p.onDuplicate]
 * @param {string} [p.title]
 * @param {string} [p.documentId]  when adding a version to an existing document
 */
async function registerUpload({ projectId, file, onDuplicate = 'skip', title, documentId = null }) {
  if (!DUPLICATE_ACTIONS.has(onDuplicate)) {
    throw new AppError(`Unknown duplicate action "${onDuplicate}".`, { code: Codes.VALIDATION, status: 400 });
  }

  const originalFilename = storage.sanitiseFilename(file.originalname);
  let meta;
  try {
    meta = await inspectTempFile(file.path, originalFilename);
  } catch (err) {
    await fsp.unlink(file.path).catch(() => {});
    throw err;
  }

  const existing = await findVersionsByHash(projectId, meta.sha256);
  const indexedDuplicate = existing.find((e) => e.status === 'indexed') || existing[0];

  let targetDocumentId = documentId;
  let versionNumber = 1;

  if (targetDocumentId) {
    const doc = await getDocumentRow(targetDocumentId);
    if (!doc || doc.project_id !== projectId) {
      await fsp.unlink(file.path).catch(() => {});
      throw new AppError('Target document not found in this project.', { code: Codes.NOT_FOUND, status: 404 });
    }
    const { rows } = await query('SELECT COALESCE(MAX(version_number), 0) AS max FROM document_versions WHERE document_id = $1', [
      targetDocumentId,
    ]);
    versionNumber = Number(rows[0].max) + 1;
  } else if (indexedDuplicate && onDuplicate === 'skip') {
    await fsp.unlink(file.path).catch(() => {});
    throw duplicateError(indexedDuplicate, originalFilename);
  } else if (indexedDuplicate && onDuplicate === 'new_version') {
    targetDocumentId = indexedDuplicate.document_id;
    const { rows } = await query('SELECT COALESCE(MAX(version_number), 0) AS max FROM document_versions WHERE document_id = $1', [
      targetDocumentId,
    ]);
    versionNumber = Number(rows[0].max) + 1;
  } else {
    targetDocumentId = newId();
  }

  const versionId = newId();
  const jobId = newId();
  const relativePath = storage.buildRelativePath({
    projectId,
    documentId: targetDocumentId,
    versionNumber,
    originalFilename,
  });

  // Move the file into place first, using application-generated ids so the
  // final path is deterministic. If the database step fails we remove it.
  await storage.moveFileIntoStorage(file.path, relativePath);

  try {
    const result = await withTransaction(async (tx) => {
      const isNewDocument = !documentId && (!indexedDuplicate || onDuplicate === 'new_document');

      if (isNewDocument) {
        await tx.query(
          `INSERT INTO documents (id, project_id, title, original_filename, file_ext, mime_type, size_bytes, sha256, storage_path, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
          [
            targetDocumentId,
            projectId,
            (title || originalFilename).trim(),
            originalFilename,
            meta.ext,
            file.mimetype || null,
            meta.size,
            meta.sha256,
            relativePath,
          ],
        );
      }

      // The previous active version becomes historical but is NOT deleted.
      await tx.query(`UPDATE document_versions SET is_active = false, status = CASE WHEN status = 'indexed' THEN 'superseded' ELSE status END WHERE document_id = $1`, [
        targetDocumentId,
      ]);

      await tx.query(
        `INSERT INTO document_versions
           (id, document_id, project_id, version_number, original_filename, file_ext, mime_type, size_bytes, sha256, storage_path, status, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',true)`,
        [
          versionId,
          targetDocumentId,
          projectId,
          versionNumber,
          originalFilename,
          meta.ext,
          file.mimetype || null,
          meta.size,
          meta.sha256,
          relativePath,
        ],
      );

      await tx.query(
        `UPDATE documents
           SET current_version_id = $2, status = 'pending', archived = false, last_error = NULL,
               size_bytes = $3, storage_path = $4, original_filename = $5, file_ext = $6, sha256 = $7, mime_type = $8
         WHERE id = $1`,
        [targetDocumentId, versionId, meta.size, relativePath, originalFilename, meta.ext, meta.sha256, file.mimetype || null],
      );

      await tx.query(
        `INSERT INTO ingestion_jobs (id, project_id, document_id, document_version_id, job_type, status, stage, max_attempts)
         VALUES ($1,$2,$3,$4,'ingest','queued','queued',$5)`,
        [jobId, projectId, targetDocumentId, versionId, config.ingestionMaxAttempts],
      );

      return { documentId: targetDocumentId, versionId, jobId, versionNumber, createdNewDocument: isNewDocument };
    });

    const { notifyWorker } = require('../ingestion/worker');
    notifyWorker();
    return result;
  } catch (err) {
    await fsp.unlink(storage.resolveStoredPath(relativePath)).catch(() => {});
    throw err;
  }
}

async function getDocumentRow(id) {
  const { rows } = await query('SELECT * FROM documents WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getDocumentWithVersions(id) {
  const doc = await getDocumentRow(id);
  if (!doc) throw new AppError('Document not found.', { code: Codes.NOT_FOUND, status: 404 });
  const { rows: versions } = await query(
    `SELECT v.id, v.version_number, v.original_filename, v.file_ext, v.size_bytes, v.sha256, v.status,
            v.is_active, v.parser, v.chunk_count, v.page_count, v.token_count, v.source_metadata,
            v.error, v.uploaded_at, v.indexed_at, v.embedding_model_id, v.storage_path,
            (SELECT COUNT(*)::int FROM document_chunks c WHERE c.document_version_id = v.id) AS actual_chunk_count
     FROM document_versions v WHERE v.document_id = $1 ORDER BY v.version_number DESC`,
    [id],
  );
  const { rows: jobs } = await query(
    `SELECT id, document_version_id, status, stage, progress, attempts, max_attempts, error, error_code, metrics,
            created_at, started_at, finished_at
     FROM ingestion_jobs WHERE document_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [id],
  );
  return { ...doc, versions, jobs };
}

async function listDocuments(projectId, { search, status, includeArchived = false, limit = 100, offset = 0, sort = 'created_at', order = 'desc' } = {}) {
  const conditions = ['d.project_id = $1'];
  const params = [projectId];
  if (!includeArchived) conditions.push('d.archived = false');
  if (status) conditions.push(`d.status = $${params.push(status)}`);
  if (search) {
    const patternParam = params.push(`%${search}%`);
    conditions.push(`(d.title ILIKE $${patternParam} OR d.original_filename ILIKE $${patternParam})`);
  }
  const sortable = { created_at: 'd.created_at', title: 'd.title', size_bytes: 'd.size_bytes', status: 'd.status', updated_at: 'd.updated_at' };
  const sortCol = sortable[sort] || 'd.created_at';
  const dir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const limitParam = params.push(Math.min(Math.max(limit, 1), 500));
  const offsetParam = params.push(Math.max(offset, 0));

  const { rows } = await query(
    `SELECT d.id, d.title, d.original_filename, d.file_ext, d.mime_type, d.size_bytes, d.status, d.archived,
            d.last_error, d.created_at, d.updated_at, d.current_version_id,
            v.version_number AS current_version_number, v.chunk_count, v.indexed_at, v.uploaded_at, v.parser,
            (SELECT COUNT(*)::int FROM document_versions vv WHERE vv.document_id = d.id) AS version_count,
            (SELECT COUNT(*)::int FROM document_chunks c WHERE c.document_id = d.id) AS chunk_count_actual,
            (SELECT COUNT(*)::int FROM ingestion_jobs j WHERE j.document_id = d.id AND j.status IN ('queued','processing')) AS active_jobs
     FROM documents d
     LEFT JOIN document_versions v ON v.id = d.current_version_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY ${sortCol} ${dir}
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total FROM documents d WHERE ${conditions.join(' AND ')}`,
    params.slice(0, params.length - 2),
  );

  return { documents: rows, total: countRows[0]?.total ?? rows.length };
}

async function deleteDocument(id, { permanent = false } = {}) {
  const doc = await getDocumentRow(id);
  if (!doc) throw new AppError('Document not found.', { code: Codes.NOT_FOUND, status: 404 });

  if (permanent) {
    // Remove the database records first (cascades to versions, chunks, jobs
    // and message_sources references), then the files on disk.
    await query('DELETE FROM documents WHERE id = $1', [id]);
    await storage.removeVersionDirectory(doc.project_id, doc.id).catch(() => {});
    return { deleted: true, permanent: true, id };
  }

  // Soft delete: archive so history and citations survive, but nothing is
  // retrieved any more.
  await withTransaction(async (tx) => {
    await tx.query(`UPDATE documents SET archived = true, status = 'archived' WHERE id = $1`, [id]);
    await tx.query(`UPDATE document_versions SET is_active = false WHERE document_id = $1`, [id]);
    await tx.query(
      `UPDATE ingestion_jobs SET status = 'cancelled', finished_at = now() WHERE document_id = $1 AND status IN ('queued','processing')`,
      [id],
    );
  });
  return { deleted: true, permanent: false, id };
}

async function restoreDocument(id) {
  const doc = await getDocumentRow(id);
  if (!doc) throw new AppError('Document not found.', { code: Codes.NOT_FOUND, status: 404 });
  await withTransaction(async (tx) => {
    await tx.query(`UPDATE documents SET archived = false, status = 'indexed' WHERE id = $1`, [id]);
    if (doc.current_version_id) {
      await tx.query(`UPDATE document_versions SET is_active = true WHERE id = $1`, [doc.current_version_id]);
    }
  });
  return { restored: true, id };
}

/** Activate a specific historical version (used by the versions UI). */
async function activateVersion(documentId, versionId) {
  const doc = await getDocumentRow(documentId);
  if (!doc) throw new AppError('Document not found.', { code: Codes.NOT_FOUND, status: 404 });
  const { rows } = await query('SELECT * FROM document_versions WHERE id = $1 AND document_id = $2', [versionId, documentId]);
  const version = rows[0];
  if (!version) throw new AppError('Version not found for this document.', { code: Codes.NOT_FOUND, status: 404 });
  if (version.status !== 'indexed') {
    throw new AppError('Only successfully indexed versions can be activated.', { code: Codes.VALIDATION, status: 409 });
  }
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE document_versions SET is_active = false, status = CASE WHEN status = 'indexed' THEN 'superseded' ELSE status END WHERE document_id = $1`,
      [documentId],
    );
    await tx.query(`UPDATE document_versions SET is_active = true, status = 'indexed' WHERE id = $1`, [versionId]);
    await tx.query(`UPDATE documents SET current_version_id = $2, status = 'indexed', last_error = NULL WHERE id = $1`, [
      documentId,
      versionId,
    ]);
  });
  return { activated: true, documentId, versionId };
}

/** Queue a re-index of the current (or a specific) version. */
async function reindexDocument(documentId, { versionId = null } = {}) {
  const doc = await getDocumentRow(documentId);
  if (!doc) throw new AppError('Document not found.', { code: Codes.NOT_FOUND, status: 404 });
  const target = versionId || doc.current_version_id;
  if (!target) throw new AppError('Document has no version to re-index.', { code: Codes.CONFLICT, status: 409 });

  const jobId = newId();
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE ingestion_jobs SET status = 'cancelled', finished_at = now()
       WHERE document_version_id = $1 AND status IN ('queued','processing')`,
      [target],
    );
    await tx.query(
      `INSERT INTO ingestion_jobs (id, project_id, document_id, document_version_id, job_type, status, stage, max_attempts)
       VALUES ($1,$2,$3,$4,'reindex','queued','queued',$5)`,
      [jobId, doc.project_id, documentId, target, config.ingestionMaxAttempts],
    );
    await tx.query(`UPDATE document_versions SET status = 'pending', error = NULL WHERE id = $1`, [target]);
    await tx.query(`UPDATE documents SET status = 'pending', last_error = NULL WHERE id = $1`, [documentId]);
  });
  const { notifyWorker } = require('../ingestion/worker');
  notifyWorker();
  return { jobId, documentId, versionId: target };
}

async function retryJob(jobId) {
  const { rows } = await query('SELECT * FROM ingestion_jobs WHERE id = $1', [jobId]);
  const job = rows[0];
  if (!job) throw new AppError('Job not found.', { code: Codes.NOT_FOUND, status: 404 });
  if (job.status === 'processing') {
    throw new AppError('That job is currently running.', { code: Codes.CONFLICT, status: 409 });
  }
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE ingestion_jobs SET status = 'queued', stage = 'queued', progress = 0, error = NULL, error_code = NULL,
              started_at = NULL, finished_at = NULL WHERE id = $1`,
      [jobId],
    );
    await tx.query(`UPDATE document_versions SET status = 'pending', error = NULL WHERE id = $1`, [job.document_version_id]);
    await tx.query(`UPDATE documents SET status = 'pending', last_error = NULL WHERE id = $1`, [job.document_id]);
  });
  const { notifyWorker } = require('../ingestion/worker');
  notifyWorker();
  return { retried: true, jobId };
}

async function listJobs(projectId, { status, limit = 50 } = {}) {
  const conditions = ['project_id = $1'];
  const params = [projectId];
  if (status) conditions.push(`status = $${params.push(status)}`);
  params.push(Math.min(limit, 200));
  const { rows } = await query(
    `SELECT j.*, d.title AS document_title, v.version_number
     FROM ingestion_jobs j
     LEFT JOIN documents d ON d.id = j.document_id
     LEFT JOIN document_versions v ON v.id = j.document_version_id
     WHERE ${conditions.map((c) => `j.${c}`).join(' AND ')}
     ORDER BY j.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

module.exports = {
  registerUpload,
  listDocuments,
  getDocumentWithVersions,
  getDocumentRow,
  deleteDocument,
  restoreDocument,
  activateVersion,
  reindexDocument,
  retryJob,
  listJobs,
  findVersionsByHash,
};
