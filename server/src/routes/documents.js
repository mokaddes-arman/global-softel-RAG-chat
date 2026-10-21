'use strict';

const express = require('express');
const path = require('node:path');
const multer = require('multer');
const { z } = require('zod');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateBody, validateQuery, validateUuidParam, booleanQuery } = require('../middleware/validate');
const { config, ensureRuntimeDirs } = require('../config/env');
const { AppError, Codes } = require('../lib/errors');
const { newId } = require('../lib/ids');
const { query } = require('../db');
const storage = require('../lib/storage');
const documents = require('../services/documents');
const projects = require('../services/projects');
const parsers = require('../ingestion/parsers');

const router = express.Router();

ensureRuntimeDirs();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureRuntimeDirs();
      cb(null, config.paths.tmp);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(storage.sanitiseFilename(file.originalname)).slice(0, 12).replace(/[^.\w]/g, '');
      cb(null, `${newId()}${ext}`);
    },
  }),
  limits: {
    fileSize: config.maxUploadSizeMb * 1024 * 1024,
    files: 25,
    fields: 20,
  },
});

const duplicateQuery = z.object({ onDuplicate: z.enum(['skip', 'new_version', 'new_document']).optional() });

/** Upload one or many files into a project. Each file is processed independently. */
router.post(
  '/projects/:projectId/documents/upload',
  validateUuidParam('projectId'),
  upload.array('files', 25),
  asyncHandler(async (req, res) => {
    await projects.requireProject(req.params.projectId);
    const files = req.files || [];
    if (!files.length) {
      throw new AppError('No files were received. Attach files under the "files" field.', { code: Codes.BAD_REQUEST, status: 400 });
    }
    const onDuplicate = duplicateQuery.parse(req.query || {}).onDuplicate || 'skip';
    const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 200) : undefined;

    const results = [];
    for (const file of files) {
      try {
        const registered = await documents.registerUpload({
          projectId: req.params.projectId,
          file,
          onDuplicate,
          title,
        });
        results.push({
          filename: file.originalname,
          ok: true,
          ...registered,
          supportedFormat: parsers.isSupported(path.extname(file.originalname).replace(/^\./, '').toLowerCase()),
        });
      } catch (err) {
        results.push({
          filename: file.originalname,
          ok: false,
          error: { code: err.code || 'upload_failed', message: err.message, details: err.details },
        });
      }
    }

    const summary = {
      received: files.length,
      accepted: results.filter((r) => r.ok).length,
      rejected: results.filter((r) => !r.ok).length,
      duplicates: results.filter((r) => r.error?.code === Codes.DUPLICATE_DOCUMENT).length,
    };
    res.status(summary.accepted ? 202 : 400).json({ results, summary });
  }),
);

/** Add a new version to an existing document. */
router.post(
  '/documents/:id/versions',
  validateUuidParam('id'),
  upload.array('files', 1),
  asyncHandler(async (req, res) => {
    const doc = await documents.getDocumentRow(req.params.id);
    if (!doc) throw new AppError('Document not found.', { code: Codes.NOT_FOUND, status: 404 });
    const files = req.files || [];
    if (!files.length) throw new AppError('No file was received.', { code: Codes.BAD_REQUEST, status: 400 });
    const registered = await documents.registerUpload({
      projectId: doc.project_id,
      file: files[0],
      documentId: doc.id,
    });
    res.status(202).json({ result: { filename: files[0].originalname, ok: true, ...registered } });
  }),
);

router.get(
  '/documents/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json({ document: await documents.getDocumentWithVersions(req.params.id) });
  }),
);

router.delete(
  '/documents/:id',
  validateUuidParam('id'),
  validateQuery(z.object({ permanent: booleanQuery() })),
  asyncHandler(async (req, res) => {
    const permanent = Boolean(req.validatedQuery?.permanent);
    res.json(await documents.deleteDocument(req.params.id, { permanent }));
  }),
);

router.post(
  '/documents/:id/restore',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json(await documents.restoreDocument(req.params.id));
  }),
);

router.post(
  '/documents/:id/reindex',
  validateUuidParam('id'),
  validateBody(z.object({ versionId: z.string().uuid().optional().nullable() })),
  asyncHandler(async (req, res) => {
    res.status(202).json(await documents.reindexDocument(req.params.id, { versionId: req.validated.versionId || null }));
  }),
);

router.post(
  '/documents/:id/activate-version',
  validateUuidParam('id'),
  validateBody(z.object({ versionId: z.string().uuid() })),
  asyncHandler(async (req, res) => {
    res.json(await documents.activateVersion(req.params.id, req.validated.versionId));
  }),
);

/** Serve the original stored file for a document (or a specific version). */
router.get(
  '/documents/:id/file',
  validateUuidParam('id'),
  validateQuery(z.object({ versionId: z.string().uuid().optional(), download: z.coerce.boolean().optional() })),
  asyncHandler(async (req, res) => {
    const doc = await documents.getDocumentWithVersions(req.params.id);
    const wanted = req.validatedQuery?.versionId;
    const version = wanted ? doc.versions.find((v) => v.id === wanted) : doc.versions.find((v) => v.id === doc.current_version_id);
    if (!version) throw new AppError('No stored file for that version.', { code: Codes.NOT_FOUND, status: 404 });

    const absolute = storage.resolveStoredPath(version.storage_path);
    if (!storage.fileExists(version.storage_path)) {
      throw new AppError('The stored file is missing from disk.', { code: Codes.NOT_FOUND, status: 410 });
    }
    const safeName = storage.sanitiseFilename(version.original_filename);
    res.setHeader('Content-Disposition', `${req.validatedQuery?.download ? 'attachment' : 'inline'}; filename="${safeName}"`);
    if (version.mime_type) res.type(version.mime_type);
    // `dotfiles: 'allow'` is safe here: the path was already confined to the
    // storage root by resolveStoredPath() and the filename was sanitised, and
    // the storage root itself may legitimately live in a dotted directory.
    res.sendFile(absolute, { dotfiles: 'allow' }, (err) => {
      if (err) {
        req.log?.error({ err: err.message, code: err.code, absolute }, 'failed to send stored file');
        if (!res.headersSent) res.status(500).json({ error: { code: 'file_read_failed', message: 'Could not read the stored file.' } });
      }
    });
  }),
);

/** Full content + metadata of a single retrieved chunk (citation inspection). */
router.get(
  '/chunks/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT c.id, c.content, c.chunk_index, c.token_count, c.char_count, c.metadata, c.created_at,
              d.id AS document_id, d.title AS document_title, d.original_filename, d.file_ext,
              v.id AS document_version_id, v.version_number, v.status AS version_status, v.is_active
       FROM document_chunks c
       JOIN documents d ON d.id = c.document_id
       JOIN document_versions v ON v.id = c.document_version_id
       WHERE c.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) throw new AppError('Chunk not found.', { code: Codes.NOT_FOUND, status: 404 });
    res.json({ chunk: rows[0] });
  }),
);

router.post(
  '/jobs/:id/retry',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.status(202).json(await documents.retryJob(req.params.id));
  }),
);

module.exports = router;
