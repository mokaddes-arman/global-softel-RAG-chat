/* globals describe, it, expect, beforeAll, afterAll, beforeEach */
const h = require('../helpers');

describe('provider configuration API', () => {
  beforeAll(async () => {
    await h.setupTestApp();
  });
  afterAll(async () => {
    await h.teardownTestApp();
  });
  beforeEach(async () => {
    await h.resetData();
  });

  it('lists the provider adapters that are actually implemented', async () => {
    const res = await h.request(h.getApp()).get('/api/providers/metadata').expect(200);
    const llmIds = res.body.llm.map((p) => p.id);
    // Only OpenRouter and Groq can answer questions (plus the offline mock
    // that is registered for the test suite only).
    expect(llmIds).toEqual(expect.arrayContaining(['groq', 'openrouter']));
    for (const removed of ['openai', 'anthropic', 'google', 'opencode']) {
      expect(llmIds).not.toContain(removed);
    }
    const embeddingIds = res.body.embedding.map((p) => p.id);
    expect(embeddingIds).toEqual(expect.arrayContaining(['local', 'ollama', 'openai', 'hash']));
    // Anything still in the list must expose the fields the UI depends on.
    for (const p of res.body.llm) {
      expect(typeof p.requiresKey).toBe('boolean');
      expect(typeof p.supportsStreaming).toBe('boolean');
    }
  });

  it('encrypts an API key at rest and only ever returns a masked hint', async () => {
    const rawKey = 'sk-live-supersecret-value-0123456789abcdef';
    const res = await h.request(h.getApp())
      .post('/api/providers/llm')
      .send({ name: 'Prod OpenRouter', provider: 'openrouter', model: 'deepseek/deepseek-chat-v3-0324:free', apiKey: rawKey, isDefaultChat: true })
      .expect(201);

    const config = res.body.config;
    expect(config.hasKey).toBe(true);
    expect(config.keyMasked).toBeTruthy();
    // The plaintext key must not appear anywhere in the response body.
    expect(JSON.stringify(res.body)).not.toContain(rawKey);
    // ... and the masked form must not contain the middle of the secret.
    expect(config.keyMasked).not.toContain('supersecret');

    // The database stores ciphertext + IV + tag, never the plaintext.
    const { rows } = await h.query(
      'SELECT key_enc, key_iv, key_tag, key_hint FROM llm_provider_configs WHERE id = $1',
      [config.id],
    );
    expect(rows[0].key_enc).toBeTruthy();
    expect(rows[0].key_iv).toBeTruthy();
    expect(rows[0].key_tag).toBeTruthy();
    expect(JSON.stringify(rows[0])).not.toContain(rawKey);
    expect(rows[0].key_hint).toBe(config.keyMasked);
  });

  it('refuses to create a provider that needs a key without one', async () => {
    const res = await h.request(h.getApp())
      .post('/api/providers/llm')
      .send({ name: 'No key', provider: 'groq', model: 'llama-3.1-8b-instant' })
      .expect(422);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('refuses to create a provider that was removed', async () => {
    for (const removed of ['openai', 'anthropic', 'google', 'opencode']) {
      const res = await h.request(h.getApp())
        .post('/api/providers/llm')
        .send({ name: 'Removed', provider: removed, model: 'x', apiKey: 'k' })
        .expect(400);
      expect(res.body.error.message).toMatch(/unknown llm provider/i);
    }
  });

  it('rejects an unknown provider id with actionable guidance', async () => {
    const res = await h.request(h.getApp())
      .post('/api/providers/llm')
      .send({ name: 'Bogus', provider: 'not-a-real-provider', model: 'x', apiKey: 'k' })
      .expect(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.message).toMatch(/unknown llm provider/i);
  });

  it('keeps exactly one default chat configuration', async () => {
    const first = await h.addMockProvider({ name: 'First', isDefaultChat: true });
    const second = await h.request(h.getApp())
      .post('/api/providers/llm')
      .send({ name: 'Second', provider: 'mock', model: 'mock-1', isDefaultChat: true })
      .expect(201);

    const list = await h.request(h.getApp()).get('/api/providers/llm').expect(200);
    const defaults = list.body.configs.filter((c) => c.is_default_chat);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(second.body.config.id);

    // Promoting the first back demotes the second.
    await h.request(h.getApp()).post(`/api/providers/llm/${first.id}/default`).expect(200);
    const after = await h.request(h.getApp()).get('/api/providers/llm').expect(200);
    expect(after.body.configs.filter((c) => c.is_default_chat).map((c) => c.id)).toEqual([first.id]);
  });

  it('updates a key (replace and clear) without ever echoing it', async () => {
    const created = await h.request(h.getApp())
      .post('/api/providers/llm')
      .send({ name: 'Rotate', provider: 'openrouter', model: 'deepseek/deepseek-chat-v3-0324:free', apiKey: 'sk-first-key-1111111111' })
      .expect(201);
    const id = created.body.config.id;

    const replaced = await h.request(h.getApp())
      .patch(`/api/providers/llm/${id}`)
      .send({ apiKey: 'sk-second-key-2222222222' })
      .expect(200);
    expect(replaced.body.config.hasKey).toBe(true);
    expect(JSON.stringify(replaced.body)).not.toContain('sk-second-key');
    expect(replaced.body.config.keyMasked).not.toBe(created.body.config.keyMasked);

    const cleared = await h.request(h.getApp()).patch(`/api/providers/llm/${id}`).send({ apiKey: null }).expect(200);
    expect(cleared.body.config.hasKey).toBe(false);
    expect(cleared.body.config.keyMasked).toBeNull();
  });

  it('tests the mock provider without touching the network', async () => {
    const created = await h.addMockProvider();
    const res = await h.request(h.getApp()).post(`/api/providers/llm/${created.id}/test`).expect(200);
    expect(res.body.ok).toBe(true);
    // The result is recorded on the configuration for the UI.
    const after = await h.request(h.getApp()).get(`/api/providers/llm/${created.id}`).expect(200);
    expect(after.body.config.last_test_ok).toBe(true);
    expect(after.body.config.last_tested_at).toBeTruthy();
  });

  it('supports testing unsaved settings, and blocks key providers without one', async () => {
    const ok = await h.request(h.getApp())
      .post('/api/providers/llm/test')
      .send({ provider: 'mock', model: 'mock-1' })
      .expect(200);
    expect(ok.body.ok).toBe(true);

    const blocked = await h.request(h.getApp())
      .post('/api/providers/llm/test')
      .send({ provider: 'openrouter', model: 'deepseek/deepseek-chat-v3-0324:free' })
      .expect(422);
    expect(blocked.body.error.message).toMatch(/requires an api key/i);
  });

  it('deletes a provider configuration', async () => {
    const created = await h.addMockProvider();
    await h.request(h.getApp()).delete(`/api/providers/llm/${created.id}`).expect(200);
    await h.request(h.getApp()).get(`/api/providers/llm/${created.id}`).expect(404);
  });

  it('stores embedding configurations with an encrypted key and a dimension', async () => {
    const res = await h.request(h.getApp())
      .post('/api/providers/embedding')
      .send({
        name: 'Hash (offline)',
        provider: 'hash',
        model: 'hash-384',
        dimension: 384,
        isDefault: true,
      })
      .expect(201);
    expect(res.body.config.dimension).toBe(384);
    expect(res.body.config.hasKey).toBe(false);

    const keyed = await h.request(h.getApp())
      .post('/api/providers/embedding')
      .send({
        name: 'OpenAI embeddings',
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimension: 1536,
        apiKey: 'sk-embed-secret-abcdefghij',
      })
      .expect(201);
    expect(keyed.body.config.hasKey).toBe(true);
    expect(JSON.stringify(keyed.body)).not.toContain('sk-embed-secret');

    const list = await h.request(h.getApp()).get('/api/providers/embedding').expect(200);
    expect(list.body.configs).toHaveLength(2);
    const defaults = list.body.configs.filter((c) => c.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(res.body.config.id);

    await h.request(h.getApp()).delete(`/api/providers/embedding/${keyed.body.config.id}`).expect(200);
    const remaining = await h.request(h.getApp()).get('/api/providers/embedding').expect(200);
    expect(remaining.body.configs).toHaveLength(1);
  });

  it('rejects an embedding dimension that is not a positive integer', async () => {
    const res = await h.request(h.getApp())
      .post('/api/providers/embedding')
      .send({ name: 'Bad', provider: 'hash', model: 'hash-384', dimension: 0 })
      .expect(422);
    expect(res.body.error.code).toBe('validation_error');
  });
});
