'use strict';

/**
 * Shared test helpers: boot the real application against a throwaway embedded
 * PostgreSQL database, upload documents, and wait for ingestion to finish.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');

const { initDb, closeDb, query } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { createApp } = require('../src/app');
const { startWorker, stopWorker, drainQueue } = require('../src/ingestion/worker');
const { config, ensureRuntimeDirs } = require('../src/config/env');

let app = null;

async function setupTestApp() {
  ensureRuntimeDirs();
  await initDb();
  await migrate({ log: false });
  await startWorker();
  app = createApp();
  return app;
}

async function teardownTestApp() {
  await stopWorker().catch(() => {});
  await closeDb().catch(() => {});
  app = null;
}

function getApp() {
  if (!app) throw new Error('setupTestApp() must run first');
  return app;
}

/** Wipe all application data between tests (keeps migrations in place). */
async function resetData() {
  await query(`TRUNCATE message_sources, messages, conversations, document_chunks, ingestion_jobs,
                        document_versions, documents, embedding_models, embedding_configs,
                        llm_provider_configs, projects, application_settings CASCADE`);
}

async function createProject(name = 'Test Project', description = null) {
  const res = await request(getApp()).post('/api/projects').send({ name, description }).expect(201);
  return res.body.project;
}

/** Upload raw content as a file into a project. */
async function uploadFile(projectId, filename, content, { onDuplicate, authHeaders } = {}) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const req = request(getApp())
    .post(`/api/projects/${projectId}/documents/upload${onDuplicate ? `?onDuplicate=${onDuplicate}` : ''}`)
    .attach('files', buffer, filename);
  if (authHeaders) Object.assign(req, authHeaders);
  return req;
}

/** Upload and wait until ingestion settles, returning the document id. */
async function uploadAndIndex(projectId, filename, content, options = {}) {
  const res = await uploadFile(projectId, filename, content, options);
  if (res.status >= 400) {
    const err = new Error(`upload failed (${res.status}): ${JSON.stringify(res.body)}`);
    err.response = res;
    throw err;
  }
  const first = res.body.results[0];
  if (!first?.ok) {
    const err = new Error(`upload rejected: ${JSON.stringify(first?.error)}`);
    err.result = first;
    throw err;
  }
  await waitForIndexing(first.documentId);
  return first.documentId;
}

async function waitForIndexing(documentId, { timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(getApp()).get(`/api/documents/${documentId}`);
    const status = res.body.document?.status;
    if (status === 'indexed' || status === 'failed') return res.body.document;
    if (Date.now() > deadline) throw new Error(`indexing did not finish in time (status=${status})`);
    await drainQueue({ timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function createConversation(projectId, body = {}) {
  const res = await request(getApp()).post(`/api/projects/${projectId}/conversations`).send(body).expect(201);
  return res.body.conversation;
}

/** Ask a question without streaming (simplest assertion shape). */
async function ask(conversationId, question, options = {}) {
  const res = await request(getApp())
    .post(`/api/conversations/${conversationId}/messages`)
    .send({ question, stream: false, ...options });
  return res;
}

/** Register a provider configuration (mock by default). */
async function addMockProvider({ name = 'Mock Provider', isDefaultChat = true } = {}) {
  const res = await request(getApp())
    .post('/api/providers/llm')
    .send({ name, provider: 'mock', model: 'mock-1', isDefaultChat })
    .expect(201);
  return res.body.config;
}

function tempFile(name, content) {
  const p = path.join(os.tmpdir(), `rag-test-${Date.now()}-${name}`);
  fs.writeFileSync(p, content);
  return p;
}

module.exports = {
  setupTestApp,
  teardownTestApp,
  getApp,
  resetData,
  createProject,
  uploadFile,
  uploadAndIndex,
  waitForIndexing,
  createConversation,
  ask,
  addMockProvider,
  tempFile,
  request,
  query,
  config,
};
