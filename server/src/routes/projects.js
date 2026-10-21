'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateBody, validateUuidParam, validateQuery, booleanQuery } = require('../middleware/validate');
const { notFound } = require('../lib/errors');
const projects = require('../services/projects');
const documents = require('../services/documents');
const conversations = require('../services/conversations');
const storage = require('../lib/storage');

const router = express.Router();

const createSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required').max(200),
  description: z.string().trim().max(4000).optional().nullable(),
  instructions: z.string().trim().max(8000).optional().nullable(),
  settings: z.record(z.string(), z.any()).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).optional().nullable(),
  instructions: z.string().trim().max(8000).optional().nullable(),
  status: z.enum(['active', 'archived']).optional(),
  settings: z.record(z.string(), z.any()).optional(),
});

router.get(
  '/',
  validateQuery(z.object({ includeArchived: booleanQuery() })),
  asyncHandler(async (req, res) => {
    res.json({ projects: await projects.listProjects({ includeArchived: Boolean(req.validatedQuery?.includeArchived) }) });
  }),
);

router.post(
  '/',
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const project = await projects.createProject(req.validated);
    res.status(201).json({ project });
  }),
);

router.get(
  '/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    const project = await projects.requireProject(req.params.id);
    res.json({ project });
  }),
);

router.patch(
  '/:id',
  validateUuidParam('id'),
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const project = await projects.updateProject(req.params.id, req.validated);
    res.json({ project });
  }),
);

router.post(
  '/:id/archive',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json({ project: await projects.archiveProject(req.params.id) });
  }),
);

router.post(
  '/:id/restore',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json({ project: await projects.restoreProject(req.params.id) });
  }),
);

/**
 * Permanently delete a project. Files are removed from disk first; if that
 * fails the request fails before the database record disappears.
 */
router.delete(
  '/:id',
  validateUuidParam('id'),
  validateQuery(z.object({ confirm: z.literal('yes') })),
  asyncHandler(async (req, res) => {
    const project = await projects.requireProject(req.params.id);
    const { rows } = await require('../db').query('SELECT id FROM documents WHERE project_id = $1', [project.id]);
    for (const doc of rows) {
      await storage.removeVersionDirectory(project.id, doc.id).catch(() => {});
    }
    await projects.deleteProject(project.id);
    res.json({ deleted: true, id: project.id });
  }),
);

router.get(
  '/:id/stats',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    await projects.requireProject(req.params.id);
    res.json({ stats: await projects.projectStats(req.params.id) });
  }),
);

router.get(
  '/:id/documents',
  validateUuidParam('id'),
  validateQuery(
    z.object({
      search: z.string().trim().max(200).optional(),
      status: z.enum(['pending', 'processing', 'indexed', 'failed', 'archived']).optional(),
      includeArchived: booleanQuery(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      sort: z.enum(['created_at', 'title', 'size_bytes', 'status', 'updated_at']).optional(),
      order: z.enum(['asc', 'desc']).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    await projects.requireProject(req.params.id);
    const result = await documents.listDocuments(req.params.id, req.validatedQuery || {});
    res.json(result);
  }),
);

router.get(
  '/:id/conversations',
  validateUuidParam('id'),
  validateQuery(
    z.object({
      search: z.string().trim().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      includeArchived: booleanQuery(),
    }),
  ),
  asyncHandler(async (req, res) => {
    await projects.requireProject(req.params.id);
    res.json({ conversations: await conversations.listConversations(req.params.id, req.validatedQuery || {}) });
  }),
);

router.get(
  '/:id/jobs',
  validateUuidParam('id'),
  validateQuery(
    z.object({ status: z.enum(['queued', 'processing', 'completed', 'failed', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
  ),
  asyncHandler(async (req, res) => {
    await projects.requireProject(req.params.id);
    res.json({ jobs: await documents.listJobs(req.params.id, req.validatedQuery || {}) });
  }),
);

router.get(
  '/:id/search',
  validateUuidParam('id'),
  validateQuery(
    z.object({
      q: z.string().trim().min(1).max(500),
      topK: z.coerce.number().int().min(1).max(50).optional(),
      // Explicit opt-in to include superseded/historical document versions.
      includeHistoricalVersions: booleanQuery(),
    }),
  ),
  asyncHandler(async (req, res) => {
    await projects.requireProject(req.params.id);
    const result = await conversations.retrieveEvidence({
      projectId: req.params.id,
      question: req.validatedQuery.q,
      options: {
        retrieval: {
          topK: req.validatedQuery.topK,
          includeHistoricalVersions: Boolean(req.validatedQuery.includeHistoricalVersions),
        },
      },
    });
    res.json({ question: req.validatedQuery.q, sources: result.sources, stats: result.stats });
  }),
);

module.exports = router;
