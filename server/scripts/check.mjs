#!/usr/bin/env node
/**
 * Backend self-check (`npm run check`).
 *
 * Boots the configured database (embedded PGlite by default, or PostgreSQL when
 * DATABASE_URL is set), verifies the schema and pgvector are healthy, and
 * prints a readiness report. Exits non-zero on a blocking failure so it can be
 * used in CI.
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failures = 0;
let warnings = 0;
const tag = {
  ok: '\x1b[32m[ ok ]\x1b[0m',
  warn: '\x1b[33m[warn]\x1b[0m',
  fail: '\x1b[31m[fail]\x1b[0m',
  info: '\x1b[36m[info]\x1b[0m',
};
const ok = (m) => console.log(`${tag.ok} ${m}`);
const warn = (m) => {
  warnings += 1;
  console.log(`${tag.warn} ${m}`);
};
const fail = (m) => {
  failures += 1;
  console.log(`${tag.fail} ${m}`);
};
const info = (m) => console.log(`${tag.info} ${m}`);

async function main() {
  console.log('\nGlobal Softel RAG Chat — backend check\n');

  // Imported after any env is already loaded by the module itself.
  const { config, getMasterKey } = require('../src/config/env');
  const { initDb, query, dbKind, closeDb } = require('../src/db');
  const { status: migrationStatus } = require('../src/db/migrate');
  const { embeddingIndexStatus } = require('../src/services/embeddings');
  const { listLlmProviders } = require('../src/llm');
  const { listEmbeddingProviders } = require('../src/embeddings');
  const { supportedExtensions } = require('../src/ingestion/parsers');

  let db;
  try {
    db = await initDb();
    await query('SELECT 1');
    ok(`database reachable (${dbKind()})`);
  } catch (err) {
    fail(`database unreachable: ${err.message}`);
    return;
  }

  // --- migrations -----------------------------------------------------------
  try {
    const status = await migrationStatus();
    if (status.pending.length) {
      warn(
        `${status.pending.length} pending migration(s): ${status.pending.join(', ')}. Run \`npm run db:migrate\`.`,
      );
    } else {
      ok(`${status.applied.length} migration(s) applied, none pending (embedding dim ${status.embeddingDim})`);
    }
  } catch (err) {
    fail(`could not read migration status: ${err.message}`);
  }

  // --- pgvector -------------------------------------------------------------
  try {
    const { rows } = await query(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
    if (rows.length) ok('pgvector extension is installed');
    else fail('pgvector extension is not installed — retrieval will not work.');
  } catch (err) {
    fail(`could not verify pgvector: ${err.message}`);
  }

  // --- core tables ----------------------------------------------------------
  try {
    const { rows } = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM projects) AS projects,
         (SELECT COUNT(*)::int FROM documents) AS documents,
         (SELECT COUNT(*)::int FROM document_chunks) AS chunks,
         (SELECT COUNT(*)::int FROM conversations) AS conversations`,
    );
    const c = rows[0];
    ok(`core tables present (projects ${c.projects}, documents ${c.documents}, chunks ${c.chunks}, conversations ${c.conversations})`);
  } catch (err) {
    fail(`core tables are missing or unreadable: ${err.message}. Run \`npm run db:migrate\`.`);
  }

  // --- master key -----------------------------------------------------------
  if (getMasterKey()) ok('APP_MASTER_KEY is configured (provider keys can be encrypted)');
  else warn('APP_MASTER_KEY is not set — saving a provider configuration will fail until it is.');

  // --- embeddings -----------------------------------------------------------
  try {
    const emb = await embeddingIndexStatus();
    if (emb.error) {
      warn(`embedding configuration problem: ${emb.error.message}`);
    } else {
      ok(`active embedding model: ${emb.active.provider}:${emb.active.model} (${emb.active.dimension} dims, source: ${emb.active.source})`);
      if (emb.needsReindex) warn(`${emb.staleChunks} chunk(s) are stale relative to the active model.`);
    }
  } catch (err) {
    warn(`could not resolve the embedding model: ${err.message}`);
  }

  // --- providers & formats --------------------------------------------------
  info(`LLM providers: ${listLlmProviders().map((p) => p.id).join(', ')}`);
  info(`Embedding providers: ${listEmbeddingProviders().map((p) => p.id).join(', ')}`);
  info(`${supportedExtensions().length} document formats supported`);
  info(`hosted AI ${config.disableHostedAi ? 'DISABLED' : 'enabled'}`);

  await closeDb().catch(() => {});
}

main()
  .catch((err) => {
    fail(`unexpected error: ${err.message}`);
  })
  .finally(() => {
    console.log('');
    if (failures > 0) {
      console.log(`${tag.fail} ${failures} blocking issue(s), ${warnings} warning(s).`);
      process.exit(1);
    }
    if (warnings > 0) console.log(`${tag.warn} check passed with ${warnings} warning(s).`);
    else console.log(`${tag.ok} all checks passed.`);
    process.exit(0);
  });
