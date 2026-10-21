/* globals describe, it, expect, beforeAll, afterAll, beforeEach */
const h = require('../helpers');

describe('hybrid retrieval and project isolation', () => {
  let projectA;
  let projectB;
  let docA;

  beforeAll(async () => {
    await h.setupTestApp();
  });
  afterAll(async () => {
    await h.teardownTestApp();
  });
  beforeEach(async () => {
    await h.resetData();
    projectA = await h.createProject('IXPF');
    projectB = await h.createProject('Boo Energi');
    docA = await h.uploadAndIndex(
      projectA.id,
      'auth.md',
      '# Authentication\n\nThe IXPF platform issues zzqsingularmarker session tokens that expire after 30 minutes.\n',
    );
    await h.uploadAndIndex(projectB.id, 'billing.md', 'Boo Energi billing runs every qqpmonthlymarker cycle.');
  });

  it('returns only chunks from the requested project', async () => {
    const res = await h.request(h.getApp()).get(`/api/projects/${projectA.id}/search?q=zzqsingularmarker`).expect(200);
    expect(res.body.sources.length).toBeGreaterThan(0);
    for (const source of res.body.sources) {
      expect(source.projectId).toBe(projectA.id);
      expect(source.documentTitle).not.toContain('billing');
    }
  });

  it('never leaks another project\u2019s chunks into a scoped search', async () => {
    const res = await h.request(h.getApp()).get(`/api/projects/${projectA.id}/search?q=qqpmonthlymarker`).expect(200);
    const leaked = res.body.sources.filter((s) => s.documentTitle.includes('billing'));
    expect(leaked).toHaveLength(0);
  });

  it('produces citations with a real document title, version and location', async () => {
    const res = await h.request(h.getApp()).get(`/api/projects/${projectA.id}/search?q=zzqsingularmarker`).expect(200);
    const top = res.body.sources[0];
    expect(top.documentTitle).toContain('auth');
    expect(top.documentVersionNumber).toBe(1);
    expect(top.sourceLocation).toBeTruthy();
    expect(top.excerpt).toContain('zzqsingularmarker');
    // The cited chunk must actually exist in the database.
    const chunk = await h.request(h.getApp()).get(`/api/chunks/${top.chunkId}`).expect(200);
    expect(chunk.body.chunk.content).toContain('zzqsingularmarker');
    expect(chunk.body.chunk.document_id).toBe(docA);
  });

  it('fuses vector and keyword search and reports both ranks', async () => {
    const res = await h.request(h.getApp()).get(`/api/projects/${projectA.id}/search?q=zzqsingularmarker`).expect(200);
    const withKeyword = res.body.sources.filter((s) => s.keywordRank !== null);
    expect(withKeyword.length).toBeGreaterThan(0);
    expect(res.body.stats.vectorCount).toBeGreaterThan(0);
    expect(res.body.stats.keywordCount).toBeGreaterThan(0);
  });

  it('excludes superseded versions by default and includes them on request', async () => {
    const docId = await h.uploadAndIndex(projectA.id, 'limits.md', 'Retry limit is 3 attempts for the oldmarker control.');
    await h.request(h.getApp())
      .post(`/api/documents/${docId}/versions`)
      .attach('files', Buffer.from('Retry limit is 5 attempts for the newmarker control.'), 'limits2.md')
      .expect(202);
    await h.waitForIndexing(docId);

    const current = await h.request(h.getApp()).get(`/api/projects/${projectA.id}/search?q=oldmarker`).expect(200);
    expect(current.body.sources.filter((s) => s.excerpt.includes('oldmarker'))).toHaveLength(0);

    const historical = await h.request(h.getApp()).get(`/api/projects/${projectA.id}/search?q=oldmarker&includeHistoricalVersions=true`).expect(200);
    expect(historical.body.sources.length).toBeGreaterThan(0);

    const activeOnly = await h.request(h.getApp()).get(`/api/projects/${projectA.id}/search?q=newmarker`).expect(200);
    expect(activeOnly.body.sources.some((s) => s.excerpt.includes('newmarker'))).toBe(true);
  });

  it('returns an empty result set for a project with no documents', async () => {
    const empty = await h.createProject('Empty Project');
    const res = await h.request(h.getApp()).get(`/api/projects/${empty.id}/search?q=anything`).expect(200);
    expect(res.body.sources).toHaveLength(0);
    expect(res.body.stats.reason).toBe('no_projects');
  });
});
