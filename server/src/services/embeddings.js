'use strict';

const { query } = require('../db');
const { config } = require('../config/env');
const { AppError, Codes } = require('../lib/errors');

/**
 * Embedding configuration + the embedding-model registry.
 *
 * Retrieval always filters chunks by `embedding_model_id`, so vectors produced
 * by different models are never mixed in one search space. When the active
 * model changes, previously indexed chunks become "stale" and the UI asks for
 * a re-index instead of silently returning wrong results.
 */

async function getSetting(key) {
  const { rows } = await query('SELECT value FROM application_settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO application_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value ?? null)],
  );
}

async function listEmbeddingConfigs() {
  const { rows } = await query(
    `SELECT id, name, provider, model, dimension, base_url, key_hint,
            (key_enc IS NOT NULL) AS has_key, extra, enabled, is_default, created_at, updated_at
     FROM embedding_configs ORDER BY is_default DESC, name ASC`,
  );
  return rows.map((r) => ({ ...r, keyMasked: r.has_key ? r.key_hint : null, has_key: undefined }));
}

/**
 * Resolve which embedding configuration is active, in priority order:
 *   explicit setting -> is_default -> environment defaults.
 * Registers the model in `embedding_models` and marks it active.
 */
async function resolveActiveEmbedding({ withSecret = true } = {}) {
  let cfg = null;

  const explicitId = await getSetting('active_embedding_config_id');
  if (explicitId) {
    const { rows } = await query('SELECT * FROM embedding_configs WHERE id = $1 AND enabled = true', [explicitId]);
    cfg = rows[0] || null;
  }
  if (!cfg) {
    const { rows } = await query('SELECT * FROM embedding_configs WHERE is_default = true AND enabled = true LIMIT 1');
    cfg = rows[0] || null;
  }

  let resolved;
  if (cfg) {
    resolved = {
      configId: cfg.id,
      provider: cfg.provider,
      model: cfg.model,
      dimension: cfg.dimension,
      baseUrl: cfg.base_url || null,
      extra: cfg.extra || {},
      keyEnc: cfg.key_enc,
      keyIv: cfg.key_iv,
      keyTag: cfg.key_tag,
      name: cfg.name,
      source: 'config',
    };
  } else {
    resolved = {
      configId: null,
      provider: config.defaultEmbeddingProvider,
      model: config.defaultEmbeddingModel,
      dimension: config.embeddingDim,
      baseUrl: null,
      extra: {},
      keyEnc: null,
      keyIv: null,
      keyTag: null,
      name: `${config.defaultEmbeddingProvider}:${config.defaultEmbeddingModel}`,
      source: 'environment',
    };
  }

  // The vector column has a fixed dimension. Refuse to run with a mismatch
  // rather than writing vectors that cannot be indexed or compared.
  if (resolved.dimension !== config.embeddingDim) {
    throw new AppError(
      `The active embedding model "${resolved.name}" produces ${resolved.dimension}-dimensional vectors, ` +
        `but the database index was created for ${config.embeddingDim} dimensions (EMBEDDING_DIM). ` +
        'Either select a model with the matching dimension, or set EMBEDDING_DIM to the new value and re-index ' +
        '(run `npm run db:migrate` after a fresh database, then re-index documents from the Documents page).',
      {
        code: Codes.EMBEDDING_DIM_MISMATCH,
        status: 409,
        details: { modelDimension: resolved.dimension, configuredDim: config.embeddingDim },
      },
    );
  }

  const modelRow = await ensureEmbeddingModel({
    provider: resolved.provider,
    model: resolved.model,
    dimension: resolved.dimension,
    configId: resolved.configId,
  });

  let apiKey = null;
  if (resolved.keyEnc && withSecret) {
    const { decryptSecret } = require('../lib/crypto');
    apiKey = decryptSecret({ ciphertext: resolved.keyEnc, iv: resolved.keyIv, tag: resolved.keyTag });
  }

  return {
    modelId: modelRow.id,
    provider: resolved.provider,
    model: resolved.model,
    dimension: resolved.dimension,
    baseUrl: resolved.baseUrl,
    apiKey,
    name: resolved.name,
    source: resolved.source,
  };
}

/** Ensure a row exists in embedding_models and that it is the single active one. */
async function ensureEmbeddingModel({ provider, model, dimension, configId = null }) {
  const { rows } = await query(
    `INSERT INTO embedding_models (provider, model, dimension, config_id, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (provider, model, dimension)
     DO UPDATE SET config_id = COALESCE(EXCLUDED.config_id, embedding_models.config_id)
     RETURNING id`,
    [provider, model, dimension, configId],
  );
  const id = rows[0].id;
  await query('UPDATE embedding_models SET is_active = (id = $1)', [id]);
  return { id };
}

/** Count chunks whose vectors came from a different model than the active one. */
async function staleChunkCount(activeModelId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS stale FROM document_chunks
     WHERE embedding_model_id IS NULL OR embedding_model_id <> $1`,
    [activeModelId],
  );
  return rows[0]?.stale ?? 0;
}

async function embeddingIndexStatus() {
  const active = await resolveActiveEmbedding({ withSecret: false }).catch((err) => ({ error: err }));
  if (active.error) return { error: { code: active.error.code, message: active.error.message } };
  const [stale, totals] = await Promise.all([
    staleChunkCount(active.modelId),
    query(`SELECT COUNT(*)::int AS total FROM document_chunks`),
  ]);
  return {
    active: { modelId: active.modelId, provider: active.provider, model: active.model, dimension: active.dimension, source: active.source },
    configuredDim: config.embeddingDim,
    totalChunks: totals.rows[0]?.total ?? 0,
    staleChunks: stale,
    needsReindex: stale > 0,
  };
}

module.exports = {
  listEmbeddingConfigs,
  resolveActiveEmbedding,
  ensureEmbeddingModel,
  embeddingIndexStatus,
  staleChunkCount,
  getSetting,
  setSetting,
};
