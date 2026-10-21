'use strict';

/**
 * Centralised, validated environment configuration.
 * Everything the application needs is read here once, so behaviour is
 * predictable and testable. Values are never logged.
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

function loadDotEnv() {
  // Load .env from the project root (one level above /server) and from /server.
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', '.env'), // <root>/.env when run from server/src/config
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env'),
  ];
  const seen = new Set();
  for (const file of candidates) {
    const abs = path.resolve(file);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (fs.existsSync(abs)) {
      require('dotenv').config({ path: abs });
      return abs;
    }
  }
  return null;
}

const envFileLoaded = loadDotEnv();

function str(name, fallback = undefined) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return String(v);
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'y'].includes(String(v).trim().toLowerCase());
}

function list(name, fallback = []) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_ROOT = path.resolve(__dirname, '..', '..');

function resolveFromRoot(p, fallback) {
  const value = p || fallback;
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

const nodeEnv = str('NODE_ENV', 'development');
const isTest = nodeEnv === 'test' || Boolean(process.env.VITEST);

const config = {
  projectRoot: PROJECT_ROOT,
  serverRoot: SERVER_ROOT,
  envFileLoaded,
  nodeEnv,
  isTest,
  isProduction: nodeEnv === 'production',

  host: str('HOST', '127.0.0.1'),
  port: int('PORT', 3001),
  logLevel: str('LOG_LEVEL', isTest ? 'silent' : 'info'),
  corsOrigins: list('CORS_ORIGIN', [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
  ]),

  databaseUrl: str('DATABASE_URL', '') || null,
  pgliteDir: resolveFromRoot(str('PGLITE_DIR'), './storage/pgdata'),

  appMasterKey: str('APP_MASTER_KEY', ''),
  storageDir: resolveFromRoot(str('STORAGE_DIR'), './storage'),
  maxUploadSizeMb: int('MAX_UPLOAD_SIZE_MB', 50),

  chunkSizeChars: int('CHUNK_SIZE_CHARS', 1200),
  chunkOverlapChars: int('CHUNK_OVERLAP_CHARS', 180),
  ingestionConcurrency: Math.max(1, int('INGESTION_CONCURRENCY', 1)),
  ingestionMaxAttempts: Math.max(1, int('INGESTION_MAX_ATTEMPTS', 3)),

  defaultEmbeddingProvider: str('DEFAULT_EMBEDDING_PROVIDER', 'local'),
  defaultEmbeddingModel: str('DEFAULT_EMBEDDING_MODEL', 'Xenova/all-MiniLM-L6-v2'),
  embeddingDim: int('EMBEDDING_DIM', 384),
  hfHome: resolveFromRoot(str('HF_HOME'), './storage/models'),

  // Only OpenRouter and Groq may answer questions.
  defaultLlmProvider: str('DEFAULT_LLM_PROVIDER', 'openrouter'),
  defaultLlmModel: str('DEFAULT_LLM_MODEL', 'deepseek/deepseek-chat-v3-0324:free'),
  disableHostedAi: bool('DISABLE_HOSTED_AI', false),

  // Optional environment defaults for providers
  groq: {
    apiKey: str('GROQ_API_KEY', ''),
    baseUrl: str('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
    model: str('GROQ_MODEL', ''),
    models: list('GROQ_MODELS', []),
  },
  openrouter: {
    apiKey: str('OPENROUTER_API_KEY', ''),
    baseUrl: str('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
    model: str('OPENROUTER_MODEL', ''),
    models: list('OPENROUTER_MODELS', []),
  },

  retrieval: {
    topK: int('RETRIEVAL_TOP_K', 8),
    vectorCandidates: int('RETRIEVAL_VECTOR_CANDIDATES', 30),
    keywordCandidates: int('RETRIEVAL_KEYWORD_CANDIDATES', 30),
    minScore: Number(process.env.RETRIEVAL_MIN_SCORE ?? 0),
    // Fraction of the best semantic score below which vector-only hits are
    // dropped (0 disables). Prevents padding context with unrelated chunks.
    relativeCutoff: Number(process.env.RETRIEVAL_RELATIVE_CUTOFF ?? 0.35),
    maxContextChars: int('RETRIEVAL_MAX_CONTEXT_CHARS', 16000),
    rerankEnabled: bool('RETRIEVAL_RERANK_ENABLED', false),
  },

  llmRequestTimeoutMs: int('LLM_REQUEST_TIMEOUT_MS', 120000),
  // Maximum time without any new token before a streaming answer is aborted.
  llmStreamIdleTimeoutMs: int('LLM_STREAM_IDLE_TIMEOUT_MS', 60000),
  embeddingRequestTimeoutMs: int('EMBEDDING_REQUEST_TIMEOUT_MS', 60000),

  // Deadlines for the ask flow. Every stage has a budget so a stalled
  // provider, embedding model or database query can never leave the UI
  // spinning forever.
  askTimeoutMs: int('ASK_TIMEOUT_MS', 180000),
  retrievalTimeoutMs: int('RETRIEVAL_TIMEOUT_MS', 60000),
  dbQueryTimeoutMs: int('DB_QUERY_TIMEOUT_MS', 30000),

  // Deadlines for the ingestion pipeline.
  ingestionParseTimeoutMs: int('INGESTION_PARSE_TIMEOUT_MS', 180000),
  ingestionJobTimeoutMs: int('INGESTION_JOB_TIMEOUT_MS', 900000),
  // A job that has been "processing" for longer than this is considered
  // orphaned (e.g. the server was killed mid-run) and is re-queued. Must stay
  // above ingestionJobTimeoutMs so a running job is never stolen.
  ingestionStaleJobMs: int('INGESTION_STALE_JOB_MS', 1200000),
};

config.paths = {
  storage: config.storageDir,
  uploads: path.join(config.storageDir, 'uploads'),
  artifacts: path.join(config.storageDir, 'artifacts'),
  tmp: path.join(config.storageDir, 'tmp'),
  models: config.hfHome,
  pglite: config.pgliteDir,
};

function ensureRuntimeDirs() {
  for (const dir of Object.values(config.paths)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * The master key protects provider API keys at rest. We derive a 32 byte key
 * from whatever the operator supplies, so short human passphrases still work,
 * but we loudly warn when it is weak or missing.
 */
function getMasterKey() {
  const raw = config.appMasterKey;
  if (!raw || raw === 'change_me_to_a_long_random_secret_at_least_32_chars') {
    if (config.isTest) {
      return crypto.createHash('sha256').update('test-master-key-not-for-production').digest();
    }
    return null;
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

module.exports = { config, ensureRuntimeDirs, getMasterKey };
