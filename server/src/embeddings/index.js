'use strict';

const path = require('node:path');
const { config } = require('../config/env');
const { logger } = require('../lib/logger');
const { AppError, Codes } = require('../lib/errors');

/**
 * Embedding provider abstraction.
 *
 * A provider turns an array of strings into an array of equal-length vectors.
 * Implemented providers:
 *   - local  : transformers.js (ONNX) running a Hugging Face embedding model
 *              entirely on this machine. No cloud call, no Ollama install.
 *   - ollama : a local Ollama server (`/api/embed`).
 *   - openai : any OpenAI-compatible /embeddings endpoint (OpenAI, Azure,
 *              LM Studio, OpenRouter, vLLM, ...).
 *   - hash   : deterministic, NON-SEMANTIC vectors. Explicitly opt-in only and
 *              intended for offline development and automated tests.
 */

const providers = {};

// ---------------------------------------------------------------------------
// cloudflare (Workers AI)
// ---------------------------------------------------------------------------
providers.cloudflare = {
  id: 'cloudflare',
  label: 'Cloudflare Workers AI',
  requiresKey: true,
  requiresBaseUrl: false,
  defaultBaseUrl: 'https://api.cloudflare.com/client/v4',
  knownModels: [
    { id: '@cf/baai/bge-base-en-v1.5', dimension: 768 },
    { id: '@cf/qwen/qwen3-embedding-0.6b', dimension: 1024 },
    { id: '@cf/baai/bge-m3', dimension: 1024 },
    { id: '@cf/baai/bge-large-en-v1.5', dimension: 1024 },
    { id: '@cf/baai/bge-small-en-v1.5', dimension: 384 },
    { id: '@cf/microsoft/multilingual-e5-small', dimension: 384 },
  ],
  async embed(texts, opts) {
    const apiKey = opts.apiKey || process.env.WORKER_API_KEY || process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_KEY;
    if (!apiKey) {
      throw new AppError('This embedding provider requires an API key (Cloudflare API token).', {
        code: Codes.INVALID_API_KEY,
        status: 400,
      });
    }
    const accountId =
      opts.extra?.accountId ||
      opts.extra?.account_id ||
      process.env.WORKER_ACCOUNT_ID ||
      process.env.CLOUDFLARE_ACCOUNT_ID ||
      process.env.CF_ACCOUNT_ID;
    if (!accountId) {
      throw new AppError('Cloudflare Workers AI requires an Account ID (set extra.accountId or WORKER_ACCOUNT_ID/CLOUDFLARE_ACCOUNT_ID).', {
        code: Codes.VALIDATION,
        status: 400,
      });
    }
    const base = (opts.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const model = opts.model || '@cf/baai/bge-base-en-v1.5';
    const url = `${base}/accounts/${accountId}/ai/run/${model}`;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ text: texts }),
      },
      config.embeddingRequestTimeoutMs,
      opts.signal,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return mapCloudflareEmbedError(res.status, text);
    }
    const json = await res.json();
    // Cloudflare returns { result: { data: [[...],[...]] } } or { result: { data: [...] } } depending on model/version
    let data = json.result?.data || json.result || json.data;
    if (Array.isArray(data) && Array.isArray(data[0]) && typeof data[0][0] === 'number') {
      return data;
    }
    if (Array.isArray(data) && typeof data[0] === 'number') {
      return [data];
    }
    // Sometimes shape is different
    if (json.result && Array.isArray(json.result)) {
      // try to detect
      if (Array.isArray(json.result[0])) return json.result;
    }
    throw new AppError('Cloudflare Workers AI returned an unexpected embedding response.', {
      code: Codes.EMBEDDING_UNAVAILABLE,
      status: 502,
    });
  },
};

function mapCloudflareEmbedError(status, bodyText) {
  const snippet = String(bodyText || '').slice(0, 300);
  if (status === 401 || status === 403) {
    throw new AppError('The Cloudflare API token was rejected.', { code: Codes.INVALID_API_KEY, status: 401 });
  }
  if (status === 404) {
    throw new AppError('The Cloudflare Workers AI model was not found.', { code: Codes.MODEL_NOT_FOUND, status: 404 });
  }
  if (status === 429) {
    throw new AppError('Cloudflare Workers AI rate-limited the request.', { code: Codes.RATE_LIMITED, status: 429 });
  }
  if (status === 400) {
    throw new AppError(`Cloudflare Workers AI bad request: ${snippet}`, { code: Codes.VALIDATION, status: 400 });
  }
  throw new AppError(`Cloudflare Workers AI error (HTTP ${status}). ${snippet}`, {
    code: Codes.EMBEDDING_UNAVAILABLE,
    status: 502,
  });
}
let localPipelinePromise = null;
let localPipelineModel = null;

async function getLocalPipeline(model) {
  if (!localPipelinePromise || localPipelineModel !== model) {
    localPipelineModel = model;
    localPipelinePromise = (async () => {
      const transformers = require('@xenova/transformers');
      // Keep everything on disk in our own cache directory.
      transformers.env.cacheDir = config.paths.models;
      transformers.env.allowRemoteModels = true;
      transformers.env.allowLocalModels = true;
      return transformers.pipeline('feature-extraction', model);
    })().catch((err) => {
      localPipelinePromise = null;
      localPipelineModel = null;
      throw err;
    });
  }
  return localPipelinePromise;
}

providers.local = {
  id: 'local',
  label: 'Local (transformers.js, on this machine)',
  requiresKey: false,
  requiresBaseUrl: false,
  knownModels: [
    { id: 'Xenova/all-MiniLM-L6-v2', dimension: 384 },
    { id: 'Xenova/bge-small-en-v1.5', dimension: 384 },
    { id: 'Xenova/all-mpnet-base-v2', dimension: 768 },
    { id: 'Xenova/gte-small', dimension: 384 },
  ],
  async embed(texts, opts) {
    const model = opts.model;
    let extractor;
    try {
      extractor = await getLocalPipeline(model);
    } catch (err) {
      throw new AppError(
        `Local embedding model "${model}" could not be loaded: ${err.message}. ` +
          'The first run downloads the model from Hugging Face, so an internet connection is required once. ' +
          'You can also set HF_HOME to a folder that already contains the model.',
        { code: Codes.EMBEDDING_UNAVAILABLE, status: 503, cause: err },
      );
    }
    const out = [];
    // Sequential to bound memory; the ONNX runtime batches poorly with large arrays.
    for (const text of texts) {
      const result = await extractor(text, { pooling: 'mean', normalize: true });
      out.push(Array.from(result.data));
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// ollama
// ---------------------------------------------------------------------------
async function fetchWithTimeout(url, init, timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(new Error('aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      const aborted = signal?.aborted;
      throw new AppError(aborted ? 'Request was cancelled.' : 'The embedding request timed out.', {
        code: aborted ? Codes.GENERATION_FAILED : Codes.NETWORK_TIMEOUT,
        status: aborted ? 499 : 504,
        cause: err,
      });
    }
    throw new AppError(`Could not reach the embedding service: ${err.message}`, {
      code: Codes.EMBEDDING_UNAVAILABLE,
      status: 503,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.('abort', onAbort);
  }
}

providers.ollama = {
  id: 'ollama',
  label: 'Ollama (local server)',
  requiresKey: false,
  requiresBaseUrl: true,
  defaultBaseUrl: 'http://127.0.0.1:11434',
  knownModels: [
    { id: 'nomic-embed-text', dimension: 768 },
    { id: 'mxbai-embed-large', dimension: 1024 },
    { id: 'all-minilm', dimension: 384 },
  ],
  async embed(texts, opts) {
    const base = (opts.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const vectors = [];
    for (const text of texts) {
      const res = await fetchWithTimeout(
        `${base}/api/embeddings`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: opts.model, prompt: text }),
        },
        config.embeddingRequestTimeoutMs,
        opts.signal,
      );
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new AppError(`Ollama embedding failed (HTTP ${res.status}). ${bodyText.slice(0, 300)}`, {
          code: res.status === 404 ? Codes.MODEL_NOT_FOUND : Codes.EMBEDDING_UNAVAILABLE,
          status: 502,
        });
      }
      const json = await res.json();
      const vec = json.embedding || json.embeddings?.[0];
      if (!Array.isArray(vec)) {
        throw new AppError('Ollama returned no embedding vector.', { code: Codes.EMBEDDING_UNAVAILABLE, status: 502 });
      }
      vectors.push(vec);
    }
    return vectors;
  },
};

// ---------------------------------------------------------------------------
// openai-compatible
// ---------------------------------------------------------------------------
providers.openai = {
  id: 'openai',
  label: 'OpenAI-compatible embeddings API',
  requiresKey: true,
  requiresBaseUrl: false,
  defaultBaseUrl: 'https://api.openai.com/v1',
  knownModels: [
    { id: 'text-embedding-3-small', dimension: 1536 },
    { id: 'text-embedding-3-large', dimension: 3072 },
  ],
  async embed(texts, opts) {
    if (!opts.apiKey) {
      throw new AppError('This embedding provider requires an API key.', { code: Codes.INVALID_API_KEY, status: 400 });
    }
    const base = (opts.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const res = await fetchWithTimeout(
      `${base}/embeddings`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ model: opts.model, input: texts }),
      },
      config.embeddingRequestTimeoutMs,
      opts.signal,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw mapOpenAiEmbedError(res.status, text);
    }
    const json = await res.json();
    const data = json.data || [];
    return data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
  },
};

function mapOpenAiEmbedError(status, bodyText) {
  const snippet = String(bodyText || '').slice(0, 300);
  if (status === 401 || status === 403) {
    return new AppError('The embedding API key was rejected.', { code: Codes.INVALID_API_KEY, status: 401 });
  }
  if (status === 404) {
    return new AppError('The embedding model was not found at this endpoint.', { code: Codes.MODEL_NOT_FOUND, status: 404 });
  }
  if (status === 429) {
    return new AppError('The embedding provider rate-limited the request.', { code: Codes.RATE_LIMITED, status: 429 });
  }
  return new AppError(`Embedding provider error (HTTP ${status}). ${snippet}`, {
    code: Codes.EMBEDDING_UNAVAILABLE,
    status: 502,
  });
}

// ---------------------------------------------------------------------------
// hash (offline / tests only)
// ---------------------------------------------------------------------------
providers.hash = {
  id: 'hash',
  label: 'Deterministic hash (offline / tests only - not semantic)',
  requiresKey: false,
  requiresBaseUrl: false,
  knownModels: [{ id: 'hash-384', dimension: 384 }, { id: 'hash-768', dimension: 768 }],
  async embed(texts, opts) {
    const crypto = require('node:crypto');
    const dim = opts.dimension || 384;
    return texts.map((text) => {
      const vec = new Array(dim).fill(0);
      const tokens = String(text)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
      for (const tok of tokens) {
        const h = crypto.createHash('sha1').update(tok).digest();
        const idx = ((h[0] << 8) | h[1]) % dim;
        const sign = h[2] % 2 === 0 ? 1 : -1;
        vec[idx] += sign;
        // A second bucket stabilises short documents a little.
        vec[((h[3] << 8) | h[4]) % dim] += sign * 0.5;
      }
      const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    });
  },
};

function getEmbeddingProvider(id) {
  const provider = providers[id];
  if (!provider) {
    throw new AppError(`Unknown embedding provider "${id}".`, { code: Codes.VALIDATION, status: 400 });
  }
  return provider;
}

function listEmbeddingProviders() {
  return Object.values(providers).map((p) => ({
    id: p.id,
    label: p.label,
    requiresKey: p.requiresKey,
    requiresBaseUrl: p.requiresBaseUrl,
    defaultBaseUrl: p.defaultBaseUrl,
    knownModels: p.knownModels,
  }));
}

/** Embed texts, validating the returned dimension against expectations. */
async function embedTexts({ provider, model, baseUrl, apiKey, dimension, signal }, texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const impl = getEmbeddingProvider(provider);
  const started = Date.now();
  const vectors = await impl.embed(texts, { model, baseUrl, apiKey, dimension, signal });
  const ms = Date.now() - started;

  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new AppError('The embedding provider returned an unexpected number of vectors.', {
      code: Codes.EMBEDDING_UNAVAILABLE,
      status: 502,
    });
  }
  const gotDim = vectors[0]?.length ?? 0;
  if (dimension && gotDim !== dimension) {
    throw new AppError(
      `Embedding dimension mismatch: the model returned ${gotDim}-dimensional vectors but the index expects ${dimension}. ` +
        'Choose a model whose dimension matches EMBEDDING_DIM, or re-index after changing EMBEDDING_DIM.',
      { code: Codes.EMBEDDING_DIM_MISMATCH, status: 409, details: { expected: dimension, actual: gotDim } },
    );
  }
  logger.debug({ provider, model, count: texts.length, ms, dim: gotDim }, 'embedded texts');
  return vectors;
}

/** Human-readable label used in the UI. */
function embeddingLabel(provider, model) {
  return `${provider}:${model}`;
}

module.exports = {
  embedTexts,
  getEmbeddingProvider,
  listEmbeddingProviders,
  embeddingLabel,
  providers,
  path,
};
