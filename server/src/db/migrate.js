'use strict';

/**
 * Minimal, explicit migration runner.
 *
 * Migrations are plain .sql files applied in lexical order and recorded in
 * `schema_migrations`. Each file is applied inside a transaction where the
 * backend supports it. The placeholder {{EMBEDDING_DIM}} is substituted from
 * configuration so the vector column dimension always matches the configured
 * embedding model.
 */
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../config/env');
const { getDb, query, dbKind, initDb } = require('./index');
const { logger } = require('../lib/logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function applyPlaceholders(sql) {
  return sql.replaceAll('{{EMBEDDING_DIM}}', String(config.embeddingDim));
}

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      checksum    text
    );
  `);
}

async function appliedMigrations() {
  const { rows } = await query('SELECT name FROM schema_migrations ORDER BY name');
  return new Set(rows.map((r) => r.name));
}

async function migrate({ log = true } = {}) {
  await initDb();
  await ensureMigrationsTable();
  const applied = await appliedMigrations();
  const files = listMigrationFiles();
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    if (log) logger.info({ backend: dbKind() }, 'Database schema is up to date');
    return { applied: [], backend: dbKind() };
  }

  const done = [];
  for (const file of pending) {
    const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const sql = applyPlaceholders(raw);
    const started = Date.now();
    // Migration scripts run as a single multi-statement batch. DDL is
    // transactional in PostgreSQL, so a failed file leaves no partial schema.
    await getDb().exec(sql);
    await query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [file]);
    done.push(file);
    if (log) logger.info({ file, ms: Date.now() - started }, 'Applied migration');
  }
  return { applied: done, backend: dbKind() };
}

async function status() {
  await initDb();
  await ensureMigrationsTable();
  const applied = await appliedMigrations();
  const files = listMigrationFiles();
  return {
    backend: dbKind(),
    embeddingDim: config.embeddingDim,
    applied: files.filter((f) => applied.has(f)),
    pending: files.filter((f) => !applied.has(f)),
  };
}

/**
 * Rollback is intentionally destructive and therefore explicit. Because the
 * whole schema is created by 001_init, "rollback" drops the application
 * objects so a fresh migrate can rebuild them. Real deployments should restore
 * from a backup instead; this is a developer convenience.
 */
async function rollback() {
  await initDb();
  await getDb().exec(`
    DROP TABLE IF EXISTS message_sources CASCADE;
    DROP TABLE IF EXISTS messages CASCADE;
    DROP TABLE IF EXISTS conversations CASCADE;
    DROP TABLE IF EXISTS document_chunks CASCADE;
    DROP TABLE IF EXISTS ingestion_jobs CASCADE;
    DROP TABLE IF EXISTS document_versions CASCADE;
    DROP TABLE IF EXISTS documents CASCADE;
    DROP TABLE IF EXISTS embedding_models CASCADE;
    DROP TABLE IF EXISTS embedding_configs CASCADE;
    DROP TABLE IF EXISTS llm_provider_configs CASCADE;
    DROP TABLE IF EXISTS projects CASCADE;
    DROP TABLE IF EXISTS application_settings CASCADE;
    DROP TABLE IF EXISTS schema_migrations CASCADE;
  `);
  logger.warn('Dropped all application tables (rollback)');
  return { rolledBack: true };
}

module.exports = { migrate, status, rollback, listMigrationFiles };
