#!/usr/bin/env node
/**
 * Retrieval evaluation runner (`npm run eval:rag`).
 *
 * Ingests the small corpus in server/eval/corpus into a throwaway embedded
 * database, then checks that each case in server/eval/cases.json retrieves (or
 * correctly fails to retrieve) the expected evidence. Because retrieval is what
 * decides whether a grounded assistant can answer at all, this is the most
 * meaningful part of the RAG pipeline to evaluate offline.
 *
 * By default it uses deterministic `hash` embeddings and the `mock` LLM so it
 * runs with no network access. Pass EVAL_EMBEDDING=configured to evaluate with
 * the embedding model from your .env instead (the first run may download it).
 *
 * Usage:
 *   node scripts/rag-eval.mjs
 *   EVAL_EMBEDDING=configured node scripts/rag-eval.mjs
 */

import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const EVAL_DIR = resolve(__dirname, '..', 'eval');
const CORPUS_DIR = join(EVAL_DIR, 'corpus');
const CASES_FILE = join(EVAL_DIR, 'cases.json');

// --- isolated, offline-by-default environment -------------------------------
// Set these BEFORE the app's config module is loaded. dotenv does not override
// already-set process.env values, so these win over the developer's .env.
const workDir = mkdtempSync(join(tmpdir(), 'rag-eval-'));
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'error';
process.env.PGLITE_DIR = join(workDir, 'pgdata');
process.env.STORAGE_DIR = join(workDir, 'storage');
process.env.DISABLE_HOSTED_AI = 'false';
process.env.DEFAULT_LLM_PROVIDER = 'mock';
process.env.DEFAULT_LLM_MODEL = 'mock';

if (process.env.EVAL_EMBEDDING === 'configured') {
  console.log('[info] using the embedding model configured in .env');
} else {
  process.env.DEFAULT_EMBEDDING_PROVIDER = 'hash';
  process.env.DEFAULT_EMBEDDING_MODEL = 'hash-384';
  process.env.EMBEDDING_DIM = '384';
}

const { config, ensureRuntimeDirs } = require('../src/config/env');
const { initDb, closeDb, dbKind } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const projects = require('../src/services/projects');
const documents = require('../src/services/documents');
const conversations = require('../src/services/conversations');
const { startWorker, stopWorker, drainQueue } = require('../src/ingestion/worker');

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function listCorpusFiles() {
  if (!existsSync(CORPUS_DIR)) return [];
  return readdirSync(CORPUS_DIR)
    .filter((f) => !f.startsWith('.'))
    .map((f) => join(CORPUS_DIR, f));
}

function mimeFor(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.md') return 'text/markdown';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.json') return 'application/json';
  return 'application/octet-stream';
}

async function ingestCorpus(projectId) {
  const files = listCorpusFiles();
  for (const file of files) {
    const originalname = file.split(/[\\/]/).pop();
    const tmpPath = join(config.paths.tmp, `${Date.now()}-${originalname}`);
    writeFileSync(tmpPath, readFileSync(file));
    await documents.registerUpload({
      projectId,
      file: {
        path: tmpPath,
        originalname,
        size: statSync(tmpPath).size,
        mimetype: mimeFor(file),
      },
      onDuplicate: 'skip',
    });
  }
  await drainQueue({ timeoutMs: 180000 });
  return files.length;
}

function sourcesText(sources) {
  return sources.map((s) => `${s.documentTitle}\n${s.excerpt}`).join('\n').toLowerCase();
}

async function main() {
  console.log('\nGlobal Softel RAG Chat — retrieval evaluation\n');
  ensureRuntimeDirs();
  await initDb();
  await migrate();
  await startWorker();

  const project = await projects.createProject({ name: 'RAG Eval Corpus' });
  const fileCount = await ingestCorpus(project.id);
  console.log(
    `[info] ingested ${fileCount} corpus file(s) using ` +
      (process.env.EVAL_EMBEDDING === 'configured' ? 'the configured embedding model' : 'hash embeddings (offline)') +
      `\n`,
  );

  const dataset = JSON.parse(readFileSync(CASES_FILE, 'utf8'));
  const results = [];

  for (const testCase of dataset.cases) {
    const { sources, stats } = await conversations.retrieveEvidence({
      projectId: project.id,
      question: testCase.question,
      options: { retrieval: { topK: 5 } },
    });

    const haystack = sourcesText(sources);
    let pass = false;
    let detail = '';

    if (testCase.expectAnswerable && testCase.anySourceContains) {
      pass = haystack.includes(testCase.anySourceContains.toLowerCase());
      detail = pass
        ? `found "${testCase.anySourceContains}"`
        : `missing "${testCase.anySourceContains}"`;
    } else if (testCase.noSourceContains) {
      pass = !haystack.includes(testCase.noSourceContains.toLowerCase());
      detail = pass
        ? `correctly absent "${testCase.noSourceContains}"`
        : `unexpectedly retrieved "${testCase.noSourceContains}"`;
    }

    results.push({ id: testCase.id, pass, detail, returned: sources.length, stats });
    const label = pass ? green('PASS') : red('FAIL');
    console.log(`  ${label}  ${testCase.id.padEnd(22)} ${dim(`(${sources.length} sources) ${detail}`)}`);
  }

  // --- end-to-end smoke test (retrieval -> grounding -> mock answer) --------
  let smokePass = false;
  try {
    const conversation = await conversations.createConversation(project.id, { title: 'eval smoke' });
    const answer = await conversations.ask({
      conversationId: conversation.id,
      question: dataset.cases[0].question,
      options: { stream: false },
    });
    smokePass = answer.ok === true && Boolean(answer.messageId);
  } catch (err) {
    console.log(`  ${red('FAIL')}  end-to-end smoke      ${dim(err.message)}`);
  }
  if (smokePass) console.log(`  ${green('PASS')}  end-to-end smoke      ${dim('ask() produced a grounded answer')}`);

  // --- summary --------------------------------------------------------------
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const accuracy = total ? ((passed / total) * 100).toFixed(1) : '0.0';
  console.log('');
  console.log(`Retrieval accuracy: ${passed}/${total} (${accuracy}%)`);
  console.log(`End-to-end smoke:   ${smokePass ? 'pass' : 'fail'}`);

  const okAll = passed === total && smokePass;
  console.log(okAll ? green('\nEvaluation passed.') : red('\nEvaluation failed.'));

  return okAll ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error(red(`\nEvaluation crashed: ${err.message}`));
  exitCode = 1;
} finally {
  await stopWorker().catch(() => {});
  await closeDb().catch(() => {});
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exitCode);
