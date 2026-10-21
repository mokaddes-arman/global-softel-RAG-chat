'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateBody, validateUuidParam } = require('../middleware/validate');
const providers = require('../services/providers');
const { listLlmProviders } = require('../llm');
const { listEmbeddingProviders } = require('../embeddings');

const router = express.Router();

const apiKeyField = z.union([z.string().max(2000), z.null()]).optional();
const extraField = z.record(z.string(), z.any()).optional();

const llmCreateSchema = z.object({
  name: z.string().trim().min(1, 'A friendly name is required').max(120),
  provider: z.string().trim().min(1).max(50),
  model: z.string().trim().min(1, 'A model name is required').max(200),
  baseUrl: z.union([z.string().trim().url(), z.literal('')]).optional().nullable(),
  apiKey: apiKeyField,
  extra: extraField,
  enabled: z.boolean().optional(),
  isDefaultChat: z.boolean().optional(),
});

const llmUpdateSchema = llmCreateSchema.partial();

const testSchema = z.object({
  provider: z.string().trim().min(1).max(50),
  model: z.string().trim().max(200).optional().default(''),
  baseUrl: z.union([z.string().trim().url(), z.literal('')]).optional().nullable(),
  apiKey: apiKeyField,
  extra: extraField,
});

const embeddingSchema = z.object({
  name: z.string().trim().min(1).max(120),
  provider: z.enum(['local', 'ollama', 'openai', 'hash']),
  model: z.string().trim().min(1).max(300),
  dimension: z.coerce.number().int().min(1).max(8192),
  baseUrl: z.union([z.string().trim().url(), z.literal('')]).optional().nullable(),
  apiKey: apiKeyField,
  extra: extraField,
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

/** Static metadata about the provider adapters implemented in code. */
router.get('/providers/metadata', (_req, res) => {
  res.json({
    llm: listLlmProviders(),
    embedding: listEmbeddingProviders(),
  });
});

// --- LLM configurations -----------------------------------------------------
router.get(
  '/providers/llm',
  asyncHandler(async (_req, res) => {
    res.json({ configs: await providers.listLlmConfigs() });
  }),
);

router.post(
  '/providers/llm',
  validateBody(llmCreateSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ config: await providers.createLlmConfig(req.validated) });
  }),
);

/** Test settings before saving them. */
router.post(
  '/providers/llm/test',
  validateBody(testSchema),
  asyncHandler(async (req, res) => {
    res.json(await providers.testAdHoc(req.validated));
  }),
);

router.get(
  '/providers/llm/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json({ config: await providers.getLlmConfig(req.params.id) });
  }),
);

router.patch(
  '/providers/llm/:id',
  validateUuidParam('id'),
  validateBody(llmUpdateSchema),
  asyncHandler(async (req, res) => {
    res.json({ config: await providers.updateLlmConfig(req.params.id, req.validated) });
  }),
);

router.delete(
  '/providers/llm/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json(await providers.deleteLlmConfig(req.params.id));
  }),
);

router.post(
  '/providers/llm/:id/test',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json(await providers.testLlmConfig(req.params.id));
  }),
);

router.post(
  '/providers/llm/:id/default',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json({ config: await providers.setDefaultChat(req.params.id) });
  }),
);

// --- Embedding configurations ----------------------------------------------
router.get(
  '/providers/embedding',
  asyncHandler(async (_req, res) => {
    res.json({ configs: await providers.listEmbeddingConfigsDetailed() });
  }),
);

router.post(
  '/providers/embedding',
  validateBody(embeddingSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ config: await providers.createEmbeddingConfig(req.validated) });
  }),
);

router.patch(
  '/providers/embedding/:id',
  validateUuidParam('id'),
  validateBody(embeddingSchema.partial()),
  asyncHandler(async (req, res) => {
    res.json({ config: await providers.updateEmbeddingConfig(req.params.id, req.validated) });
  }),
);

router.delete(
  '/providers/embedding/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json(await providers.deleteEmbeddingConfig(req.params.id));
  }),
);

router.post(
  '/providers/embedding/:id/default',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json(await providers.setDefaultEmbedding(req.params.id));
  }),
);

module.exports = router;
