'use strict';

const { query, withTransaction } = require('../db');
const { config } = require('../config/env');
const { AppError, Codes } = require('../lib/errors');
const { encryptSecret, decryptSecret, maskSecret } = require('../lib/crypto');
const {
  getLlmProvider,
  listLlmProviders,
  testProviderConnection,
  isSupportedLlmProvider,
} = require('../llm');

/**
 * CRUD + resolution for hosted LLM provider configurations.
 *
 * API keys are encrypted (AES-256-GCM) before they touch the database and are
 * only ever returned to the frontend in masked form.
 */

const PUBLIC_COLUMNS = `
  id, name, provider, model, base_url, key_hint, extra, enabled, is_default_chat,
  last_tested_at, last_test_ok, last_test_error, created_at, updated_at,
  (key_enc IS NOT NULL) AS has_key
`;

function toPublic(row) {
  if (!row) return null;
  const { has_key, ...rest } = row;
  return { ...rest, hasKey: Boolean(has_key), keyMasked: has_key ? row.key_hint : null };
}

async function listLlmConfigs() {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS} FROM llm_provider_configs ORDER BY is_default_chat DESC, name ASC`);
  return rows.map(toPublic);
}

async function getLlmConfigRaw(id) {
  const { rows } = await query('SELECT * FROM llm_provider_configs WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getLlmConfig(id) {
  const row = await getLlmConfigRaw(id);
  if (!row) throw new AppError('Provider configuration not found.', { code: Codes.NOT_FOUND, status: 404 });
  return toPublic(row);
}

function validateProviderId(provider) {
  const known = listLlmProviders().map((p) => p.id);
  if (!known.includes(provider)) {
    throw new AppError(`Unknown LLM provider "${provider}". Supported: ${known.join(', ')}.`, {
      code: Codes.VALIDATION,
      status: 400,
    });
  }
}

/** Encrypt a key into the four columns used everywhere. */
function keyColumns(apiKey) {
  if (!apiKey) return { key_enc: null, key_iv: null, key_tag: null, key_hint: null };
  const enc = encryptSecret(apiKey);
  return { key_enc: enc.ciphertext, key_iv: enc.iv, key_tag: enc.tag, key_hint: enc.hint };
}

async function createLlmConfig(input) {
  validateProviderId(input.provider);
  const impl = getLlmProvider(input.provider);
  if (impl.requiresKey && !input.apiKey) {
    throw new AppError(`Provider "${input.provider}" requires an API key.`, { code: Codes.VALIDATION, status: 422 });
  }
  const cols = keyColumns(input.apiKey);

  return withTransaction(async (tx) => {
    if (input.isDefaultChat) {
      await tx.query('UPDATE llm_provider_configs SET is_default_chat = false');
    }
    const { rows } = await tx.query(
      `INSERT INTO llm_provider_configs
         (name, provider, model, base_url, key_enc, key_iv, key_tag, key_hint, extra, enabled, is_default_chat)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
       RETURNING ${PUBLIC_COLUMNS}`,
      [
        input.name,
        input.provider,
        input.model,
        input.baseUrl || null,
        cols.key_enc,
        cols.key_iv,
        cols.key_tag,
        cols.key_hint,
        JSON.stringify(input.extra || {}),
        input.enabled !== false,
        Boolean(input.isDefaultChat),
      ],
    );
    return toPublic(rows[0]);
  });
}

async function updateLlmConfig(id, patch) {
  const existing = await getLlmConfigRaw(id);
  if (!existing) throw new AppError('Provider configuration not found.', { code: Codes.NOT_FOUND, status: 404 });
  if (patch.provider) validateProviderId(patch.provider);

  const sets = [];
  const params = [];
  const push = (col, value) => sets.push(`${col} = $${params.push(value)}`);

  if (patch.name !== undefined) push('name', patch.name);
  if (patch.provider !== undefined) push('provider', patch.provider);
  if (patch.model !== undefined) push('model', patch.model);
  if (patch.baseUrl !== undefined) push('base_url', patch.baseUrl || null);
  if (patch.enabled !== undefined) push('enabled', patch.enabled);
  if (patch.extra !== undefined) sets.push(`extra = $${params.push(JSON.stringify(patch.extra || {}))}::jsonb`);

  // apiKey semantics: undefined = keep, '' = keep, null = clear, string = replace
  if (patch.apiKey !== undefined) {
    if (patch.apiKey === null) {
      push('key_enc', null);
      push('key_iv', null);
      push('key_tag', null);
      push('key_hint', null);
    } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') {
      const cols = keyColumns(patch.apiKey.trim());
      push('key_enc', cols.key_enc);
      push('key_iv', cols.key_iv);
      push('key_tag', cols.key_tag);
      push('key_hint', cols.key_hint);
    }
  }

  params.push(id);
  return withTransaction(async (tx) => {
    if (patch.isDefaultChat === true) {
      await tx.query('UPDATE llm_provider_configs SET is_default_chat = false WHERE id <> $1', [id]);
      sets.push('is_default_chat = true');
    } else if (patch.isDefaultChat === false) {
      sets.push('is_default_chat = false');
    }
    if (!sets.length) {
      const { rows } = await tx.query(`SELECT ${PUBLIC_COLUMNS} FROM llm_provider_configs WHERE id = $1`, [id]);
      return toPublic(rows[0]);
    }
    const { rows } = await tx.query(
      `UPDATE llm_provider_configs SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${PUBLIC_COLUMNS}`,
      params,
    );
    return toPublic(rows[0]);
  });
}

async function deleteLlmConfig(id) {
  const { rows } = await query('DELETE FROM llm_provider_configs WHERE id = $1 RETURNING id', [id]);
  if (!rows[0]) throw new AppError('Provider configuration not found.', { code: Codes.NOT_FOUND, status: 404 });
  return rows[0];
}

async function setDefaultChat(id) {
  return updateLlmConfig(id, { isDefaultChat: true });
}

async function setDefaultEmbedding(id) {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query('SELECT id FROM embedding_configs WHERE id = $1', [id]);
    if (!rows[0]) throw new AppError('Embedding configuration not found.', { code: Codes.NOT_FOUND, status: 404 });
    await tx.query('UPDATE embedding_configs SET is_default = false');
    await tx.query('UPDATE embedding_configs SET is_default = true, enabled = true WHERE id = $1', [id]);
    return { ok: true, activeEmbeddingConfigId: id };
  });
}

/** Decrypt the key for an existing configuration and run a live connectivity test. */
async function testLlmConfig(id) {
  const row = await getLlmConfigRaw(id);
  if (!row) throw new AppError('Provider configuration not found.', { code: Codes.NOT_FOUND, status: 404 });
  let apiKey = null;
  if (row.key_enc) apiKey = decryptSecret({ ciphertext: row.key_enc, iv: row.key_iv, tag: row.key_tag });
  return runAndRecordTest(row, apiKey);
}

/** Test provider settings that have not been saved yet (used by the settings form). */
async function testAdHoc({ provider, model, baseUrl, apiKey, extra }) {
  validateProviderId(provider);
  const impl = getLlmProvider(provider);
  if (impl.requiresKey && !apiKey) {
    throw new AppError(`Provider "${provider}" requires an API key to test.`, { code: Codes.VALIDATION, status: 422 });
  }
  const started = Date.now();
  const result = await testProviderConnection({ provider, model, baseUrl, apiKey, extra });
  return {
    ok: Boolean(result.ok),
    latencyMs: result.latencyMs ?? Date.now() - started,
    message: result.message,
    models: result.models,
  };
}

async function runAndRecordTest(row, apiKey) {
  try {
    const result = await testProviderConnection({
      provider: row.provider,
      model: row.model,
      baseUrl: row.base_url,
      apiKey,
      extra: row.extra,
    });
    await query('UPDATE llm_provider_configs SET last_tested_at = now(), last_test_ok = $2, last_test_error = NULL WHERE id = $1', [
      row.id,
      true,
    ]);
    return { ok: true, latencyMs: result.latencyMs, message: result.message, models: result.models };
  } catch (err) {
    await query('UPDATE llm_provider_configs SET last_tested_at = now(), last_test_ok = false, last_test_error = $2 WHERE id = $1', [
      row.id,
      String(err.message).slice(0, 500),
    ]);
    return { ok: false, latencyMs: null, message: err.message, code: err.code || 'provider_error' };
  }
}

/**
 * Resolve the provider configuration used for a chat request.
 * `configId` overrides the default; otherwise the default config is used; if no
 * config exists at all, fall back to environment defaults with no key (which
 * will fail loudly if the provider needs one).
 */
async function resolveChatProvider({ configId } = {}) {
  let row = null;
  if (configId) {
    row = await getLlmConfigRaw(configId);
    if (!row) throw new AppError('Selected provider configuration not found.', { code: Codes.NOT_FOUND, status: 404 });
    if (!row.enabled) {
      throw new AppError('The selected provider configuration is disabled.', { code: Codes.VALIDATION, status: 409 });
    }
  } else {
    const { rows } = await query('SELECT * FROM llm_provider_configs WHERE is_default_chat = true AND enabled = true LIMIT 1');
    row = rows[0] || null;
  }

  if (!row) {
    // Environment fallback. Only a provider that is actually registered may
    // answer questions. `SUPPORTED_LLM_PROVIDERS` is the hosted list; the
    // offline mock is only registered in the test suite.
    const requested = String(config.defaultLlmProvider || '').trim();
    const provider = isSupportedLlmProvider(requested) ? requested : 'openrouter';
    const modelExplicit = Boolean(String(process.env.DEFAULT_LLM_MODEL || '').trim());
    let model = config.defaultLlmModel;
    let baseUrl = null;
    let apiKey = null;

    if (provider === 'groq') {
      model = modelExplicit ? config.defaultLlmModel : (config.groq.model || config.groq.models[0] || 'openai/gpt-oss-120b');
      baseUrl = config.groq.baseUrl || null;
      apiKey = config.groq.apiKey || null;
    } else if (provider === 'mock') {
      model = modelExplicit ? config.defaultLlmModel : 'mock';
    } else {
      model = modelExplicit
        ? config.defaultLlmModel
        : (config.openrouter.model || config.openrouter.models[0] || 'nvidia/nemotron-3-ultra-550b-a55b:free');
      baseUrl = config.openrouter.baseUrl || null;
      apiKey = config.openrouter.apiKey || null;
    }

    return {
      configId: null,
      provider,
      model,
      baseUrl,
      apiKey,
      extra: {},
      source: 'environment',
      name: `${provider}:${model}`,
    };
  }

  let apiKey = null;
  if (row.key_enc) apiKey = decryptSecret({ ciphertext: row.key_enc, iv: row.key_iv, tag: row.key_tag });
  return {
    configId: row.id,
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url,
    apiKey,
    extra: row.extra || {},
    source: 'config',
    name: row.name,
  };
}

/**
 * Runtime config (including the decrypted key) for the newest enabled
 * configuration of a given provider id. Returns null when no such
 * configuration exists.
 */
async function getProviderRuntimeConfig(provider) {
  const { rows } = await query(
    'SELECT * FROM llm_provider_configs WHERE provider = $1 AND enabled = true ORDER BY is_default_chat DESC, updated_at DESC LIMIT 1',
    [provider],
  );
  const row = rows[0];
  if (!row) return null;
  let apiKey = null;
  if (row.key_enc) apiKey = decryptSecret({ ciphertext: row.key_enc, iv: row.key_iv, tag: row.key_tag });
  return { configId: row.id, provider: row.provider, model: row.model, baseUrl: row.base_url, apiKey, extra: row.extra || {} };
}

// ---------------------------------------------------------------------------
// Embedding configuration CRUD (keys encrypted the same way)
// ---------------------------------------------------------------------------
async function listEmbeddingConfigsDetailed() {
  const { rows } = await query(
    `SELECT id, name, provider, model, dimension, base_url, key_hint, extra, enabled, is_default,
            created_at, updated_at, (key_enc IS NOT NULL) AS has_key
     FROM embedding_configs ORDER BY is_default DESC, name ASC`,
  );
  return rows.map((r) => ({ ...toPublic(r), dimension: r.dimension }));
}

async function createEmbeddingConfig(input) {
  const cols = keyColumns(input.apiKey);
  return withTransaction(async (tx) => {
    if (input.isDefault) await tx.query('UPDATE embedding_configs SET is_default = false');
    const { rows } = await tx.query(
      `INSERT INTO embedding_configs
         (name, provider, model, dimension, base_url, key_enc, key_iv, key_tag, key_hint, extra, enabled, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
       RETURNING id, name, provider, model, dimension, base_url, key_hint, extra, enabled, is_default, created_at, updated_at,
                 (key_enc IS NOT NULL) AS has_key`,
      [
        input.name,
        input.provider,
        input.model,
        input.dimension,
        input.baseUrl || null,
        cols.key_enc,
        cols.key_iv,
        cols.key_tag,
        cols.key_hint,
        JSON.stringify(input.extra || {}),
        input.enabled !== false,
        Boolean(input.isDefault),
      ],
    );
    if (input.isDefault) await tx.query(`UPDATE application_settings SET value = to_jsonb($1::uuid) WHERE key = 'active_embedding_config_id'`, [rows[0].id]);
    return toPublic(rows[0]);
  });
}

async function updateEmbeddingConfig(id, patch) {
  const { rows: existing } = await query('SELECT * FROM embedding_configs WHERE id = $1', [id]);
  if (!existing[0]) throw new AppError('Embedding configuration not found.', { code: Codes.NOT_FOUND, status: 404 });

  const sets = [];
  const params = [];
  const push = (col, value) => sets.push(`${col} = $${params.push(value)}`);
  if (patch.name !== undefined) push('name', patch.name);
  if (patch.provider !== undefined) push('provider', patch.provider);
  if (patch.model !== undefined) push('model', patch.model);
  if (patch.dimension !== undefined) push('dimension', patch.dimension);
  if (patch.baseUrl !== undefined) push('base_url', patch.baseUrl || null);
  if (patch.enabled !== undefined) push('enabled', patch.enabled);
  if (patch.extra !== undefined) sets.push(`extra = $${params.push(JSON.stringify(patch.extra || {}))}::jsonb`);
  if (patch.apiKey === null) {
    push('key_enc', null); push('key_iv', null); push('key_tag', null); push('key_hint', null);
  } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
    const cols = keyColumns(patch.apiKey.trim());
    push('key_enc', cols.key_enc); push('key_iv', cols.key_iv); push('key_tag', cols.key_tag); push('key_hint', cols.key_hint);
  }
  params.push(id);
  const { rows } = await query(
    `UPDATE embedding_configs SET ${sets.length ? sets.join(', ') : 'name = name'} WHERE id = $${params.length}
     RETURNING id, name, provider, model, dimension, base_url, key_hint, extra, enabled, is_default, created_at, updated_at,
               (key_enc IS NOT NULL) AS has_key`,
    params,
  );
  return toPublic(rows[0]);
}

async function deleteEmbeddingConfig(id) {
  const { rows } = await query('DELETE FROM embedding_configs WHERE id = $1 RETURNING id', [id]);
  if (!rows[0]) throw new AppError('Embedding configuration not found.', { code: Codes.NOT_FOUND, status: 404 });
  await query(`DELETE FROM application_settings WHERE key = 'active_embedding_config_id' AND value = to_jsonb($1::uuid)`, [id]);
  return rows[0];
}

module.exports = {
  listLlmConfigs,
  getLlmConfig,
  createLlmConfig,
  updateLlmConfig,
  deleteLlmConfig,
  setDefaultChat,
  testLlmConfig,
  testAdHoc,
  resolveChatProvider,
  getProviderRuntimeConfig,
  listEmbeddingConfigsDetailed,
  createEmbeddingConfig,
  updateEmbeddingConfig,
  deleteEmbeddingConfig,
  setDefaultEmbedding,
  maskSecret,
  keyColumns,
};
