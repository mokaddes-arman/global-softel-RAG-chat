'use strict';

/**
 * Test environment setup. Runs before each test file is loaded, so the
 * configuration module picks up test-appropriate values.
 *
 * Tests use:
 *   - a throwaway embedded PostgreSQL database per process
 *   - a throwaway storage directory per process
 *   - the deterministic `hash` embedding provider (no network, no model download)
 *   - the `mock` LLM provider (no network, no API keys)
 */
const path = require('node:path');
const fs = require('node:fs');

const base = path.join(__dirname, '..', 'storage', '.test');
fs.mkdirSync(base, { recursive: true });

const uniq = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.PGLITE_DIR = path.join(base, `pg-${uniq}`);
process.env.STORAGE_DIR = path.join(base, `store-${uniq}`);
process.env.HF_HOME = path.join(base, 'models');
process.env.DEFAULT_EMBEDDING_PROVIDER = 'hash';
process.env.DEFAULT_EMBEDDING_MODEL = 'hash-384';
process.env.EMBEDDING_DIM = '384';
process.env.APP_MASTER_KEY = 'unit-test-master-key-0123456789abcdefghijklmnop';
process.env.DISABLE_HOSTED_AI = 'false';
process.env.RETRIEVAL_TOP_K = '6';
process.env.CHUNK_SIZE_CHARS = '800';
process.env.CHUNK_OVERLAP_CHARS = '100';
process.env.MAX_UPLOAD_SIZE_MB = '5';
process.env.CORS_ORIGIN = 'http://localhost:5173';
