'use strict';

/**
 * Small API helpers shared by the e2e specs.
 *
 * The specs use these for fast, deterministic setup (create a project, seed a
 * document and wait for indexing) and to assert the HTTP contract directly;
 * the browser-facing assertions live in `03-ui-workflow.spec.js`.
 *
 * Everything talks to the same origin Playwright serves the SPA from, so no
 * extra configuration is required.
 */

const API_BASE = () => process.env.E2E_BASE_URL || `http://127.0.0.1:${process.env.E2E_PORT || 3101}`;

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE()}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { status: res.status, ok: res.ok, data };
}

/** @returns {Promise<{id: string, name: string}>} */
async function createProject(name) {
  const { status, ok, data } = await api('/api/projects', { method: 'POST', body: { name } });
  if (!ok) throw new Error(`createProject failed (${status}): ${JSON.stringify(data)}`);
  return data.project;
}

/** @returns {Promise<{id: string, name: string}>} */
async function createConversation(projectId, title = 'e2e') {
  const { status, ok, data } = await api(`/api/projects/${projectId}/conversations`, {
    method: 'POST',
    body: { title },
  });
  if (!ok) throw new Error(`createConversation failed (${status}): ${JSON.stringify(data)}`);
  return data.conversation;
}

/** Poll until a document has finished ingesting (or fail loudly). */
async function waitForIndexed(documentId, { timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status, ok, data } = await api(`/api/documents/${documentId}`);
    if (!ok) throw new Error(`getDocument failed (${status}): ${JSON.stringify(data)}`);
    const docStatus = data.document?.status;
    if (docStatus === 'indexed') return data.document;
    if (docStatus === 'failed') {
      throw new Error(`document ${documentId} failed to index: ${JSON.stringify(data.document)}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`document ${documentId} did not finish indexing in time (status=${docStatus})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** Upload one file to a project and wait until it is fully indexed. */
async function uploadAndIndex(projectId, filename, content, { type = 'text/markdown' } = {}) {
  const form = new FormData();
  form.append('files', new Blob([Buffer.from(content, 'utf8')], { type }), filename);
  const res = await fetch(`${API_BASE()}/api/projects/${projectId}/documents/upload`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  const first = data?.results?.[0];
  if (!first?.ok) {
    throw new Error(`upload rejected (${res.status}): ${JSON.stringify(data)}`);
  }
  const document = await waitForIndexed(first.documentId);
  return { documentId: first.documentId, document };
}

/**
 * Ask a question and return the non-streaming `result` payload the endpoint
 * wraps in `{ result }`.
 */
async function ask(conversationId, question, options = {}) {
  const { status, ok, data } = await api(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { question, stream: false, ...options },
  });
  if (!ok) throw new Error(`ask failed (${status}): ${JSON.stringify(data)}`);
  return data.result;
}

/** Retrieval only (the "inspect evidence" panel). */
async function evidence(conversationId, question, options = {}) {
  const { status, ok, data } = await api(`/api/conversations/${conversationId}/evidence`, {
    method: 'POST',
    body: { question, ...options },
  });
  if (!ok) throw new Error(`evidence failed (${status}): ${JSON.stringify(data)}`);
  return data;
}

/** A distinctive markdown document so keyword retrieval has unambiguous anchors. */
const SAMPLE_DOCUMENT = `# Platform API Specification

## Authentication

Every request to the Platform API must send an \`Authorization\` header containing
a bearer token. Tokens are issued by the identity service and expire after
60 minutes.

## Rate limits

The Platform API enforces a rate limit of 120 requests per minute for every API key.
Bursts are smoothed over a rolling 10 second window.

## Pagination

List endpoints use cursor pagination. Pass \`cursor\` and \`limit\` query parameters.
`;

const SAMPLE_QUESTION = 'What is the rate limit per minute for the Platform API?';

module.exports = {
  API_BASE,
  api,
  createProject,
  createConversation,
  waitForIndexed,
  uploadAndIndex,
  ask,
  evidence,
  SAMPLE_DOCUMENT,
  SAMPLE_QUESTION,
};
