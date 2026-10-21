'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { query, dbKind } = require('../db');
const { status: migrationStatus } = require('../db/migrate');
const { config } = require('../config/env');
const { embeddingIndexStatus } = require('../services/embeddings');
const { listLlmProviders } = require('../llm');
const { listEmbeddingProviders } = require('../embeddings');
const { supportedExtensions } = require('../ingestion/parsers');
const { workerStatus } = require('../ingestion/worker');

const router = express.Router();

/** Liveness probe - cheap, no dependencies touched. */
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), time: new Date().toISOString() });
});

/** Readiness probe - verifies the database is reachable. */
router.get(
  '/health/ready',
  asyncHandler(async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ status: 'ready', database: dbKind() });
    } catch (err) {
      res.status(503).json({ status: 'unavailable', error: { code: 'database_unavailable', message: err.message } });
    }
  }),
);

/** Full system status used by the dashboard and the Settings page. */
router.get(
  '/system/status',
  asyncHandler(async (_req, res) => {
    const migrations = await migrationStatus();
    const embeddings = await embeddingIndexStatus();
    const modelCounts = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM projects WHERE status = 'active') AS projects,
         (SELECT COUNT(*)::int FROM documents WHERE NOT archived) AS documents,
         (SELECT COUNT(*)::int FROM document_chunks) AS chunks,
         (SELECT COUNT(*)::int FROM conversations WHERE NOT archived) AS conversations,
         (SELECT COUNT(*)::int FROM ingestion_jobs WHERE status IN ('queued','processing')) AS active_jobs`,
    );
    res.json({
      app: { name: 'Global Softel RAG Chat', version: '1.0.0', nodeEnv: config.nodeEnv },
      database: { backend: migrations.backend, applied: migrations.applied, pending: migrations.pending },
      embeddings,
      worker: workerStatus(),
      hostedAi: {
        disabled: config.disableHostedAi,
        note: config.disableHostedAi
          ? 'Hosted AI calls are disabled. Retrieval, document management and citations still work; answers are not generated.'
          : 'Retrieved excerpts (not whole documents) are sent to the selected hosted LLM provider.',
      },
      limits: {
        maxUploadSizeMb: config.maxUploadSizeMb,
        chunkSizeChars: config.chunkSizeChars,
        chunkOverlapChars: config.chunkOverlapChars,
        embeddingDim: config.embeddingDim,
      },
      counts: modelCounts.rows[0],
      supportedExtensions: supportedExtensions(),
      llmProviders: listLlmProviders(),
      embeddingProviders: listEmbeddingProviders(),
    });
  }),
);

module.exports = router;
