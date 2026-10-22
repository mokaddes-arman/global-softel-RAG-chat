'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateBody, validateQuery, validateUuidParam } = require('../middleware/validate');
const projects = require('../services/projects');
const knowledge = require('../services/knowledge');

/**
 * Knowledge-base routes.
 *
 * Everything the user can add to a knowledge base besides a file upload:
 * web links, link lists, collections and the crawl jobs that fetch a page and
 * turn it into a document.
 */

const router = express.Router();

const urlsSchema = z
  .union([z.string().trim().min(1), z.array(z.string().trim().min(1))])
  .transform((value) => (Array.isArray(value) ? value : [value]));

const createLinkSchema = z.object({
  urls: urlsSchema,
  collectionId: z.string().uuid().optional().nullable(),
  title: z.string().trim().max(300).optional().nullable(),
});

const updateLinkSchema = z.object({
  title: z.string().trim().max(300).optional().nullable(),
  collectionId: z.string().uuid().optional().nullable(),
});

const createLinkListSchema = z.object({
  name: z.string().trim().min(1, 'A list name is required').max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  urls: urlsSchema.optional(),
});

const linkListItemsSchema = z.object({ urls: urlsSchema });

const importLinkListSchema = z.object({
  collectionId: z.string().uuid().optional().nullable(),
});

const createCollectionSchema = z.object({
  name: z.string().trim().min(1, 'A collection name is required').max(200),
  description: z.string().trim().max(2000).optional().nullable(),
});

const updateCollectionSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
});

const collectionItemsSchema = z.object({
  documentIds: z.array(z.string().uuid()).optional().default([]),
  webLinkIds: z.array(z.string().uuid()).optional().default([]),
});

/* -------------------------------------------------------------------------- */
/* Web links                                                                  */
/* -------------------------------------------------------------------------- */

router.get(
  '/projects/:projectId/links',
  validateUuidParam('projectId'),
  validateQuery(
    z.object({
      search: z.string().trim().max(200).optional(),
      status: z.enum(['pending', 'crawling', 'indexed', 'failed', 'archived']).optional(),
      collectionId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    await projects.requireProject(req.params.projectId);
    const links = await knowledge.listWebLinks(req.params.projectId, req.validatedQuery || {});
    res.json({ links });
  }),
);

router.post(
  '/projects/:projectId/links',
  validateUuidParam('projectId'),
  validateBody(createLinkSchema),
  asyncHandler(async (req, res) => {
    await projects.requireProject(req.params.projectId);
    const result = await knowledge.createWebLinks(req.params.projectId, req.validated.urls, {
      collectionId: req.validated.collectionId || null,
      title: req.validated.title || null,
    });
    const status = result.created.length ? 202 : result.errors.length ? 400 : 200;
    res.status(status).json(result);
  }),
);

router.get(
  '/links/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    const link = await knowledge.getWebLink(req.params.id);
    res.json({ link });
  }),
);

router.patch(
  '/links/:id',
  validateUuidParam('id'),
  validateBody(updateLinkSchema),
  asyncHandler(async (req, res) => {
    const link = await knowledge.updateWebLink(req.params.id, {
      title: req.validated.title,
      collectionId: req.validated.collectionId,
    });
    res.json({ link });
  }),
);

router.delete(
  '/links/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json(await knowledge.deleteWebLink(req.params.id));
  }),
);

/** Queue a fresh crawl of a link (the "re-crawl" action). */
router.post(
  '/links/:id/crawl',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.status(202).json(await knowledge.recrawlWebLink(req.params.id));
  }),
);

/* -------------------------------------------------------------------------- */
/* Link lists                                                                 */
/* -------------------------------------------------------------------------- */

router.get(
  '/projects/:projectId/link-lists',
  validateUuidParam('projectId'),
  asyncHandler(async (req, res) => {
    await projects.requireProject(req.params.projectId);
    res.json({ linkLists: await knowledge.listLinkLists(req.params.projectId) });
  }),
);

router.post(
  '/projects/:projectId/link-lists',
  validateUuidParam('projectId'),
  validateBody(createLinkListSchema),
  asyncHandler(async (req, res) => {
    await projects.requireProject(req.params.projectId);
    const list = await knowledge.createLinkList(req.params.projectId, {
      name: req.validated.name,
      description: req.validated.description || null,
      urls: req.validated.urls || [],
    });
    res.status(201).json({ linkList: list });
  }),
);

router.get(
  '/link-lists/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    const list = await knowledge.getLinkList(req.params.id);
    res.json({ linkList: list, items: await knowledge.listLinkListItems(req.params.id) });
  }),
);

router.post(
  '/link-lists/:id/items',
  validateUuidParam('id'),
  validateBody(linkListItemsSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await knowledge.addLinkListItems(req.params.id, req.validated.urls));
  }),
);

router.delete(
  '/link-lists/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json(await knowledge.deleteLinkList(req.params.id));
  }),
);

/** Turn every URL of a list into a knowledge-base link and crawl it. */
router.post(
  '/link-lists/:id/import',
  validateUuidParam('id'),
  validateBody(importLinkListSchema),
  asyncHandler(async (req, res) => {
    const result = await knowledge.importLinkList(req.params.id, {
      collectionId: req.validated.collectionId || null,
    });
    res.status(result.created.length ? 202 : 200).json(result);
  }),
);

/* -------------------------------------------------------------------------- */
/* Collections                                                                */
/* -------------------------------------------------------------------------- */

router.get(
  '/projects/:projectId/collections',
  validateUuidParam('projectId'),
  asyncHandler(async (req, res) => {
    await projects.requireProject(req.params.projectId);
    res.json({ collections: await knowledge.listCollections(req.params.projectId) });
  }),
);

router.post(
  '/projects/:projectId/collections',
  validateUuidParam('projectId'),
  validateBody(createCollectionSchema),
  asyncHandler(async (req, res) => {
    await projects.requireProject(req.params.projectId);
    const collection = await knowledge.createCollection(req.params.projectId, {
      name: req.validated.name,
      description: req.validated.description || null,
    });
    res.status(201).json({ collection });
  }),
);

router.get(
  '/collections/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    const collection = await knowledge.getCollection(req.params.id);
    res.json({ collection, items: await knowledge.getCollectionItems(req.params.id) });
  }),
);

router.patch(
  '/collections/:id',
  validateUuidParam('id'),
  validateBody(updateCollectionSchema),
  asyncHandler(async (req, res) => {
    res.json({ collection: await knowledge.updateCollection(req.params.id, req.validated) });
  }),
);

router.delete(
  '/collections/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json(await knowledge.deleteCollection(req.params.id));
  }),
);

router.post(
  '/collections/:id/items',
  validateUuidParam('id'),
  validateBody(collectionItemsSchema),
  asyncHandler(async (req, res) => {
    const added = await knowledge.addCollectionItems(req.params.id, {
      documentIds: req.validated.documentIds,
      webLinkIds: req.validated.webLinkIds,
    });
    res.status(201).json({ added });
  }),
);

router.delete(
  '/collections/:id/items/:itemId',
  validateUuidParam('id'),
  validateUuidParam('itemId'),
  asyncHandler(async (req, res) => {
    res.json(await knowledge.removeCollectionItem(req.params.id, req.params.itemId));
  }),
);

/* -------------------------------------------------------------------------- */
/* Crawl jobs                                                                 */
/* -------------------------------------------------------------------------- */

router.get(
  '/projects/:projectId/crawl-jobs',
  validateUuidParam('projectId'),
  validateQuery(
    z.object({
      status: z.enum(['queued', 'processing', 'completed', 'failed', 'cancelled']).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    await projects.requireProject(req.params.projectId);
    res.json({ crawlJobs: await knowledge.listCrawlJobs(req.params.projectId, req.validatedQuery || {}) });
  }),
);

router.post(
  '/crawl-jobs/:id/retry',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.status(202).json(await knowledge.retryCrawlJob(req.params.id));
  }),
);

module.exports = router;
