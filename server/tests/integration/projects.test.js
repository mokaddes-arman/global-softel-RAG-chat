/* globals describe, it, expect, beforeAll, afterAll, beforeEach */
const h = require('../helpers');

describe('projects API', () => {
  beforeAll(async () => {
    await h.setupTestApp();
  });
  afterAll(async () => {
    await h.teardownTestApp();
  });
  beforeEach(async () => {
    await h.resetData();
  });

  it('creates a project and returns an identifier with timestamps', async () => {
    const project = await h.createProject('IXPF');
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.name).toBe('IXPF');
    expect(project.status).toBe('active');
    expect(project.created_at).toBeTruthy();
    expect(project.updated_at).toBeTruthy();
  });

  it('generates unique slugs for duplicate names', async () => {
    const a = await h.createProject('Boo Energi');
    const b = await h.createProject('Boo Energi');
    expect(a.slug).not.toBe(b.slug);
    expect(a.slug).toBe('boo-energi');
  });

  it('lists active projects and excludes archived ones by default', async () => {
    const project = await h.createProject('Global Softel');
    await h.request(h.getApp()).post(`/api/projects/${project.id}/archive`).expect(200);
    const active = await h.request(h.getApp()).get('/api/projects').expect(200);
    expect(active.body.projects.map((p) => p.id)).not.toContain(project.id);
    const all = await h.request(h.getApp()).get('/api/projects?includeArchived=true').expect(200);
    expect(all.body.projects.map((p) => p.id)).toContain(project.id);
  });

  it('renames and restores a project', async () => {
    const project = await h.createProject('Temp');
    const renamed = await h.request(h.getApp()).patch(`/api/projects/${project.id}`).send({ name: 'Renamed', description: 'desc' }).expect(200);
    expect(renamed.body.project.name).toBe('Renamed');
    await h.request(h.getApp()).post(`/api/projects/${project.id}/archive`).expect(200);
    const restored = await h.request(h.getApp()).post(`/api/projects/${project.id}/restore`).expect(200);
    expect(restored.body.project.status).toBe('active');
  });

  it('round-trips per-project instructions on create and update', async () => {
    const created = await h
      .request(h.getApp())
      .post('/api/projects')
      .send({ name: 'Persona', instructions: '  You are a Senior SQA Engineer.  ' })
      .expect(201);
    // Zod trims the value before it is stored.
    expect(created.body.project.instructions).toBe('You are a Senior SQA Engineer.');

    const patched = await h
      .request(h.getApp())
      .patch(`/api/projects/${created.body.project.id}`)
      .send({ instructions: 'Act as a release manager.' })
      .expect(200);
    expect(patched.body.project.instructions).toBe('Act as a release manager.');

    // Clearing the instructions (the UI sends null) removes the persona.
    const cleared = await h
      .request(h.getApp())
      .patch(`/api/projects/${created.body.project.id}`)
      .send({ instructions: null })
      .expect(200);
    expect(cleared.body.project.instructions).toBeNull();
  });

  it('defaults instructions to null and rejects instructions over 8000 characters', async () => {
    const project = await h.createProject('No persona');
    expect(project.instructions).toBeNull();

    const res = await h
      .request(h.getApp())
      .post('/api/projects')
      .send({ name: 'Too long', instructions: 'x'.repeat(8001) })
      .expect(422);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('requires explicit confirmation to delete a project', async () => {
    const project = await h.createProject('Danger');
    await h.request(h.getApp()).delete(`/api/projects/${project.id}`).expect(422);
    await h.request(h.getApp()).delete(`/api/projects/${project.id}?confirm=yes`).expect(200);
    await h.request(h.getApp()).get(`/api/projects/${project.id}`).expect(404);
  });

  it('rejects an empty project name with a validation error', async () => {
    const res = await h.request(h.getApp()).post('/api/projects').send({ name: '   ' }).expect(422);
    expect(res.body.error.code).toBe('validation_error');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('returns 404 for an unknown project id', async () => {
    await h.request(h.getApp()).get('/api/projects/00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('returns 400 for a malformed project id', async () => {
    const res = await h.request(h.getApp()).get('/api/projects/not-a-uuid').expect(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('reports dashboard statistics from real data', async () => {
    const project = await h.createProject('Stats');
    await h.uploadAndIndex(project.id, 'notes.md', '# Notes\n\nThe retry limit is three attempts.');
    const res = await h.request(h.getApp()).get(`/api/projects/${project.id}/stats`).expect(200);
    expect(res.body.stats.documents.total_documents).toBe(1);
    expect(res.body.stats.documents.indexed_documents).toBe(1);
    expect(res.body.stats.chunks.total_chunks).toBeGreaterThan(0);
    expect(res.body.stats.recentUploads.length).toBe(1);
  });
});
