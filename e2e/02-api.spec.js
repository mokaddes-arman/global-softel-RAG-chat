'use strict';

/**
 * Stage 2: the RAG contract end to end, driven through the HTTP API.
 *
 * Seeding via the API keeps these assertions fast and deterministic, so failures
 * here are genuinely about retrieval/grounding rather than about clicking the
 * right control. The browser-driven equivalent lives in `03-ui-workflow`.
 */

const { test, expect } = require('@playwright/test');
const {
  api,
  createProject,
  createConversation,
  uploadAndIndex,
  ask,
  evidence,
  SAMPLE_DOCUMENT,
  SAMPLE_QUESTION,
} = require('./helpers');

test.describe.configure({ mode: 'serial' });

let projectId;
let documentId;

test.beforeAll(async () => {
  const project = await createProject(`API Workflow ${Date.now()}`);
  projectId = project.id;
  const uploaded = await uploadAndIndex(projectId, 'platform-api.md', SAMPLE_DOCUMENT);
  documentId = uploaded.documentId;
});

test('document upload is ingested and indexed', async ({ request }) => {
  const res = await request.get(`/api/documents/${documentId}`);
  expect(res.ok()).toBeTruthy();
  const { document } = await res.json();
  expect(document.status).toBe('indexed');
});

test('hybrid retrieval returns the relevant evidence', async ({ request }) => {
  const res = await request.get(
    `/api/projects/${projectId}/search?q=${encodeURIComponent(SAMPLE_QUESTION)}`,
  );
  expect(res.ok()).toBeTruthy();
  const body = await res.json();

  expect(body.sources.length, 'at least one chunk must be retrieved').toBeGreaterThan(0);
  expect(body.stats.returned).toBe(body.sources.length);

  const haystack = body.sources
    .map((s) => `${s.documentTitle}\n${s.excerpt}`)
    .join('\n')
    .toLowerCase();
  expect(haystack).toContain('rate limit');

  // Every citation must point at a real, inspectable chunk.
  for (const source of body.sources) {
    expect(source.chunkId).toBeTruthy();
    expect(source.documentId).toBeTruthy();
    expect(source.rank).toBeGreaterThan(0);
  }
});

test('evidence inspection matches retrieval without calling a model', async () => {
  const conversation = await createConversation(projectId, 'evidence');
  const result = await evidence(conversation.id, SAMPLE_QUESTION);
  expect(result.sources.length).toBeGreaterThan(0);
  expect(result.stats.returned).toBe(result.sources.length);
});

test('the answer is grounded and carries verifiable citations', async () => {
  const conversation = await createConversation(projectId, 'grounded');
  const result = await ask(conversation.id, SAMPLE_QUESTION);

  expect(result.ok).toBe(true);
  // The offline `mock` provider echoes how many evidence blocks it received.
  expect(result.content).toMatch(/\[mock\] I found \d+ evidence block/);
  expect(result.sources.length, 'sources are persisted with the message').toBeGreaterThan(0);

  const first = result.sources[0];
  expect(first.chunkId).toBeTruthy();
  expect(first.documentId).toBeTruthy();
  expect(first.documentVersionId).toBeTruthy();
  expect(String(first.excerpt).length).toBeGreaterThan(0);
});

test('citations persist and can be reloaded with the conversation', async ({ request }) => {
  const conversation = await createConversation(projectId, 'persist');
  await ask(conversation.id, SAMPLE_QUESTION);

  const res = await request.get(`/api/conversations/${conversation.id}/messages`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();

  expect(body.messages.filter((m) => m.role === 'assistant').length).toBeGreaterThan(0);
  expect(body.sources.length).toBeGreaterThan(0);
  expect(body.sources[0].citation_label).toBe('[1]');
});

test('the assistant abstains when the scoped project has no content', async () => {
  const empty = await createProject(`Empty ${Date.now()}`);
  const conversation = await createConversation(empty.id, 'abstain');
  const result = await ask(conversation.id, SAMPLE_QUESTION);

  expect(result.ok).toBe(true);
  expect(result.noEvidence).toBe(true);
  expect(result.sources).toEqual([]);
  expect(result.message.content).toMatch(/I found no relevant passages/);
  expect(result.message.retrieval_meta?.stats?.reason).toBe('no_projects');
});

test('project instructions round-trip over HTTP', async () => {
  const created = await api('/api/projects', {
    method: 'POST',
    body: { name: `Persona ${Date.now()}`, instructions: 'You are a Senior SQA Engineer.' },
  });
  expect(created.ok).toBeTruthy();
  expect(created.data.project.instructions).toBe('You are a Senior SQA Engineer.');
  const id = created.data.project.id;

  const patched = await api(`/api/projects/${id}`, {
    method: 'PATCH',
    body: { instructions: 'Act as a release manager.' },
  });
  expect(patched.ok).toBeTruthy();
  expect(patched.data.project.instructions).toBe('Act as a release manager.');

  const fetched = await api(`/api/projects/${id}`);
  expect(fetched.ok).toBeTruthy();
  expect(fetched.data.project.instructions).toBe('Act as a release manager.');
});

test('project isolation: cross-project search stays off unless requested', async () => {
  const other = await createProject(`Isolated ${Date.now()}`);
  const conversation = await createConversation(other.id, 'isolation');

  // Default scope: this project only, even though another project has evidence.
  const scoped = await evidence(conversation.id, SAMPLE_QUESTION);
  expect(scoped.sources).toEqual([]);
  expect(scoped.stats.reason).toBe('no_projects');

  // Explicit opt-in: the same question now sees every active project.
  const cross = await evidence(conversation.id, SAMPLE_QUESTION, { crossProject: true });
  expect(cross.sources.length).toBeGreaterThan(0);
});
