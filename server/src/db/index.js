'use strict';

/**
 * Database access layer.
 *
 * The application speaks plain PostgreSQL SQL and pgvector operators. Two
 * backends are supported behind one tiny interface:
 *
 *   1. A real PostgreSQL server (with the pgvector extension) when DATABASE_URL
 *      is configured - the recommended production path.
 *   2. The embedded PGlite build - real PostgreSQL compiled to WebAssembly with
 *      the real pgvector extension - used automatically when DATABASE_URL is
 *      empty, so the app runs with zero database installation.
 *
 * Both backends expose:
 *   query(text, params) -> { rows, rowCount }
 *   withTransaction(fn) -> fn receives a { query } handle
 *   exec(sql)           -> run a multi-statement script
 *   close()
 */
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { config } = require('../config/env');
const { logger } = require('../lib/logger');
const { AppError, Codes } = require('../lib/errors');

let adapter = null;
let initPromise = null;

/**
 * Tracks whether the current async call stack is inside a transaction.
 *
 * PGlite uses a single connection: issuing a query on the *outer* connection
 * while a transaction is open deadlocks (the transaction holds the connection,
 * the outer query waits for it to be released). That deadlock looks exactly
 * like "the app hangs", so it is turned into a loud error instead.
 */
const txContext = new AsyncLocalStorage();

function normaliseResult(res) {
  const rows = res?.rows ?? [];
  const rowCount = res?.rowCount ?? res?.affectedRows ?? rows.length;
  return { rows, rowCount };
}

/**
 * Run a query with a deadline. A query that does not answer in time is
 * reported as an error instead of blocking the caller forever.
 */
async function withQueryTimeout(promise, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new AppError(`The database ${label} did not answer within ${Math.round(timeoutMs / 1000)}s.`, {
          code: Codes.DATABASE_TIMEOUT,
          status: 504,
        }),
      );
    }, timeoutMs);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function createPostgresAdapter() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'global-softel-rag-chat',
  });
  pool.on('error', (err) => logger.error({ err: err.message }, 'Postgres pool error'));

  try {
    const probe = await pool.query('SELECT 1 AS ok');
    if (!probe.rows?.[0]) throw new Error('empty probe result');
  } catch (err) {
    await pool.end().catch(() => {});
    throw new AppError(
      `Cannot reach PostgreSQL at DATABASE_URL: ${err.message}. ` +
        'Check the connection string and that the server is running.',
      { code: Codes.DATABASE_UNAVAILABLE, status: 503, cause: err },
    );
  }

  logger.info('Database: connected to PostgreSQL server');
  return {
    kind: 'postgres',
    query: async (text, params) => normaliseResult(await pool.query(text, params)),
    exec: async (sql) => {
      await pool.query(sql);
    },
    withTransaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = { query: async (t, p) => normaliseResult(await client.query(t, p)) };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: async () => pool.end(),
  };
}

async function createPgliteAdapter() {
  const pgliteMod = require('@electric-sql/pglite');
  const vectorMod = require('@electric-sql/pglite-pgvector');
  const PGlite = pgliteMod.PGlite ?? pgliteMod.default?.PGlite ?? pgliteMod.default;
  const vector = vectorMod.vector ?? vectorMod.default?.vector ?? vectorMod.default;

  if (!PGlite) throw new Error('PGlite not available');

  const dataDir = config.paths.pglite;
  fs.mkdirSync(dataDir, { recursive: true });

  const db = new PGlite(dataDir, { extensions: { vector } });
  await db.waitReady;

  // Confirm the pgvector extension really loaded; retrieval depends on it.
  try {
    await db.exec('CREATE EXTENSION IF NOT EXISTS vector;');
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not create the vector extension in PGlite');
  }

  logger.info({ dataDir }, 'Database: connected to embedded PostgreSQL (PGlite + pgvector)');

  return {
    kind: 'pglite',
    query: async (text, params) => {
      const res = await db.query(text, params);
      return { rows: res.rows ?? [], rowCount: res.affectedRows ?? res.rows?.length ?? 0 };
    },
    exec: async (sql) => {
      await db.exec(sql);
    },
    withTransaction: async (fn) => {
      // IMPORTANT: the callback must query through the transaction handle that
      // PGlite provides. Calling the outer `db.query` inside `db.transaction`
      // deadlocks, because the open transaction holds the single PGlite
      // connection while the outer query waits for it to be released.
      return db.transaction(async (tx) => {
        const handle = { query: async (t, p) => normaliseResult(await tx.query(t, p)) };
        return fn(handle);
      });
    },
    close: async () => db.close(),
  };
}

async function initDb() {
  if (adapter) return adapter;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    adapter = config.databaseUrl ? await createPostgresAdapter() : await createPgliteAdapter();
    return adapter;
  })().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

/**
 * Serialises transactions inside this process.
 *
 * The embedded PGlite backend has a *single* connection, so two overlapping
 * `BEGIN`/`COMMIT` pairs would interleave: the second transaction's
 * statements would run inside the first one and the second COMMIT would have
 * nothing to commit. The ingestion worker and the crawl worker both write, so
 * they must not overlap.
 */
let transactionChain = Promise.resolve();

function withTransaction(fn) {
  const run = () =>
    txContext.run({ inTransaction: true }, () => getDb().withTransaction(fn));
  const result = transactionChain.then(run, run);
  // Keep the chain alive even when a transaction rejects.
  transactionChain = result.then(
    () => {},
    () => {},
  );
  return result;
}

function getDb() {
  if (!adapter) {
    throw new AppError('Database has not been initialised yet. Call initDb() first.', {
      code: Codes.DATABASE_UNAVAILABLE,
      status: 503,
    });
  }
  return adapter;
}

async function query(text, params = []) {
  if (txContext.getStore()) {
    throw new AppError(
      'A query was issued on the outer connection while a transaction was open. ' +
        'Use the transaction handle (tx.query) inside withTransaction().',
      { code: Codes.DATABASE_DEADLOCK, status: 500 },
    );
  }
  return withQueryTimeout(getDb().query(text, params), config.dbQueryTimeoutMs, 'query');
}

async function closeDb() {
  if (adapter) {
    await adapter.close();
    adapter = null;
    initPromise = null;
  }
}

/** Test helper: report which backend is in use. */
const dbKind = () => adapter?.kind ?? null;

module.exports = { initDb, getDb, query, withTransaction, closeDb, dbKind, normaliseResult };
