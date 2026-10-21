/* globals describe, it, expect, beforeAll, afterAll, beforeEach */
const h = require('../helpers');

/**
 * /api/model-usage derives per-model usage from completed assistant messages in
 * the app's own database.
 */

async function insertMessage({ conversationId, projectId, role = 'assistant', status = 'complete', provider, model, tokenUsage, hoursAgo = 0 }) {
  await h.query(
    `INSERT INTO messages (conversation_id, project_id, role, content, status, provider, model, token_usage, created_at)
     VALUES ($1,$2,$3,'x',$4,$5,$6,$7::jsonb, now() - make_interval(hours => $8))`,
    [conversationId, projectId, role, status, provider || null, model || null, JSON.stringify(tokenUsage || {}), hoursAgo],
  );
}

describe('model usage API', () => {
  let project;
  let conversation;

  beforeAll(async () => {
    await h.setupTestApp();
  });
  afterAll(async () => {
    await h.teardownTestApp();
  });
  beforeEach(async () => {
    await h.resetData();
    project = await h.createProject('Usage Project');
    conversation = await h.createConversation(project.id);
  });

  async function seed() {
    const base = { conversationId: conversation.id, projectId: project.id };
    // Groq usage
    await insertMessage({ ...base, provider: 'groq', model: 'llama-3.1-8b-instant', tokenUsage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, hoursAgo: 30 });
    await insertMessage({ ...base, provider: 'groq', model: 'llama-3.1-8b-instant', tokenUsage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 }, hoursAgo: 1, });
    // OpenRouter usage {prompt_tokens, completion_tokens}
    await insertMessage({ ...base, provider: 'openrouter', model: 'deepseek/deepseek-chat-v3-0324:free', tokenUsage: { prompt_tokens: 10, completion_tokens: 5 }, hoursAgo: 2 });
    // Must NOT be counted:
    await insertMessage({ ...base, role: 'user', model: null, tokenUsage: null, hoursAgo: 2 });
    await insertMessage({ ...base, status: 'error', provider: 'openrouter', model: 'deepseek/deepseek-chat-v3-0324:free', tokenUsage: { prompt_tokens: 999, completion_tokens: 999 }, hoursAgo: 2 });
  }

  it('aggregates tokens per model across provider-specific usage shapes', async () => {
    await seed();
    const res = await h.request(h.getApp())
      .get('/api/model-usage')
      .query({ granularity: 'day' })
      .expect(200);

    expect(res.body.totals.requests).toBe(3);
    expect(res.body.totals.inputTokens).toBe(310); // 100+200+10
    expect(res.body.totals.outputTokens).toBe(135); // 50+80+5
    expect(res.body.totals.totalTokens).toBe(445);
    expect(res.body.totals.modelCount).toBe(2);

    const llama = res.body.models.find((m) => m.model === 'llama-3.1-8b-instant');
    expect(llama.requests).toBe(2);
    expect(llama.inputTokens).toBe(300);
    expect(llama.outputTokens).toBe(130);
    expect(llama.totalTokens).toBe(430);
    expect(llama.avgTokensPerRequest).toBe(215);
    expect(llama.provider).toBe('groq');
  });

  it('buckets usage over time and keeps bucket totals consistent', async () => {
    await seed();
    const res = await h.request(h.getApp())
      .get('/api/model-usage')
      .query({ granularity: 'day', from: new Date(Date.now() - 7 * 864e5).toISOString(), to: new Date(Date.now() + 36e5).toISOString() })
      .expect(200);

    expect(res.body.buckets.length).toBeGreaterThanOrEqual(2);
    const summed = res.body.buckets.reduce((acc, b) => acc + b.totalTokens, 0);
    expect(summed).toBe(res.body.totals.totalTokens);
    for (const b of res.body.buckets) expect(b.label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('collapses to a single bucket when grouped monthly', async () => {
    await seed();
    const res = await h.request(h.getApp())
      .get('/api/model-usage')
      .query({ granularity: 'month', from: new Date(Date.now() - 40 * 864e5).toISOString(), to: new Date(Date.now() + 36e5).toISOString() })
      .expect(200);
    expect(res.body.buckets.length).toBeGreaterThanOrEqual(1);
    expect(res.body.buckets.every((b) => /^\d{4}-\d{2}$/.test(b.label))).toBe(true);
  });

  it('filters by model', async () => {
    await seed();
    const res = await h.request(h.getApp())
      .get('/api/model-usage')
      .query({ model: 'llama-3.1-8b-instant' })
      .expect(200);
    expect(res.body.totals.requests).toBe(2);
    expect(res.body.models).toHaveLength(1);
    expect(res.body.models[0].model).toBe('llama-3.1-8b-instant');
  });

  it('returns an empty report for a period with no usage', async () => {
    await seed();
    const res = await h.request(h.getApp())
      .get('/api/model-usage')
      .query({ from: '2000-01-01', to: '2000-01-02' })
      .expect(200);
    expect(res.body.models).toHaveLength(0);
    expect(res.body.totals.requests).toBe(0);
  });

  it('rejects an unknown granularity', async () => {
    const res = await h.request(h.getApp()).get('/api/model-usage').query({ granularity: 'fortnight' }).expect(422);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('reports the catalog as not configured when there is no provider', async () => {
    const res = await h.request(h.getApp()).get('/api/model-usage/catalog').expect(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.models).toEqual([]);
  });
});
