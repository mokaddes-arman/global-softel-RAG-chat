/* globals describe, it, expect, beforeAll, afterAll, beforeEach */
const h = require('../helpers');

describe('document ingestion', () => {
  let project;
  beforeAll(async () => {
    await h.setupTestApp();
  });
  afterAll(async () => {
    await h.teardownTestApp();
  });
  beforeEach(async () => {
    await h.resetData();
    project = await h.createProject('Docs');
  });

  it('uploads, parses, chunks and embeds a markdown document', async () => {
    const docId = await h.uploadAndIndex(
      project.id,
      'requirements.md',
      '# Login\n\nUsers authenticate with SSO.\n\n## Limits\n\nRetries are capped at three.\n',
    );
    const res = await h.request(h.getApp()).get(`/api/documents/${docId}`).expect(200);
    const doc = res.body.document;
    expect(doc.status).toBe('indexed');
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0].is_active).toBe(true);
    expect(doc.versions[0].chunk_count).toBeGreaterThan(0);
    expect(doc.versions[0].embedding_model_id).toBeTruthy();
    expect(res.body.document.jobs[0].status).toBe('completed');
  });

  it('stores chunks that are retrievable and whose embeddings exist', async () => {
    const docId = await h.uploadAndIndex(project.id, 'a.txt', 'The deployment window is Sunday 02:00 UTC.');
    const { rows } = await h.query('SELECT content, embedding IS NOT NULL AS has_vec, token_count FROM document_chunks WHERE document_id = $1', [docId]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].has_vec).toBe(true);
    expect(rows[0].content).toContain('Sunday');
  });

  it('rejects a duplicate upload with an actionable conflict', async () => {
    const content = 'Duplicated policy content here.';
    await h.uploadAndIndex(project.id, 'policy.txt', content);
    const res = await h.uploadFile(project.id, 'policy-copy.txt', content);
    expect(res.status).toBe(400);
    const result = res.body.results[0];
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('duplicate_document');
    expect(result.error.details.existingDocumentId).toBeTruthy();
    expect(result.error.details.options).toContain('new_version');
  });

  it('creates a new version and marks the previous one as superseded', async () => {
    const content = 'Release 1.0 supports CSV export.';
    const docId = await h.uploadAndIndex(project.id, 'release.md', content);

    // A byte-identical upload can be explicitly filed as a new version by
    // passing onDuplicate=new_version (the option offered by the conflict).
    const res = await h.uploadFile(project.id, 'release-v2.md', content, { onDuplicate: 'new_version' });
    expect(res.status).toBe(202);
    const first = res.body.results[0];
    expect(first.ok).toBe(true);
    expect(first.documentId).toBe(docId);
    expect(first.versionNumber).toBe(2);
    await h.waitForIndexing(docId);

    // The dedicated version endpoint keeps numbering consistent.
    const versioned = await h.request(h.getApp())
      .post(`/api/documents/${docId}/versions`)
      .attach('files', Buffer.from('Release 2.0 replaces CSV export with XLSX export.'), 'release2.md')
      .expect(202);
    expect(versioned.body.result.versionNumber).toBe(3);
    await h.waitForIndexing(docId);

    const doc = (await h.request(h.getApp()).get(`/api/documents/${docId}`).expect(200)).body.document;
    expect(doc.versions).toHaveLength(3);
    const active = doc.versions.filter((v) => v.is_active);
    expect(active).toHaveLength(1);
    expect(active[0].version_number).toBe(3);
    expect(doc.versions.find((v) => v.version_number === 1).status).toBe('superseded');
    expect(doc.versions.find((v) => v.version_number === 2).status).toBe('superseded');
    // Historical version content must be preserved, not deleted.
    const { rows } = await h.query('SELECT COUNT(*)::int AS n FROM document_chunks WHERE document_id = $1', [docId]);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('keeps a duplicate as a separate document when asked', async () => {
    const content = 'Shared boilerplate text.';
    await h.uploadAndIndex(project.id, 'one.txt', content);
    const res = await h.uploadFile(project.id, 'two.txt', content, { onDuplicate: 'new_document' });
    expect(res.body.results[0].ok).toBe(true);
    await h.waitForIndexing(res.body.results[0].documentId);
    const list = await h.request(h.getApp()).get(`/api/projects/${project.id}/documents`).expect(200);
    expect(list.body.documents).toHaveLength(2);
  });

  it('rejects unsupported formats with a 415 and a helpful message', async () => {
    const res = await h.uploadFile(project.id, 'legacy.doc', Buffer.from('D0CF11E0A1B11AE1', 'hex'));
    const result = res.body.results[0];
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('unsupported_format');
    expect(result.error.message).toMatch(/docx|pdf/i);
  });

  it('rejects an empty file', async () => {
    const res = await h.uploadFile(project.id, 'empty.txt', Buffer.alloc(0));
    expect(res.body.results[0].error.code).toBe('bad_request');
  });

  it('fails gracefully when a text file is actually binary, then retries safely', async () => {
    const binary = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(200, 7)]);
    const res = await h.uploadFile(project.id, 'weird.txt', binary);
    const docId = res.body.results[0].documentId;
    const doc = await h.waitForIndexing(docId);
    expect(doc.status).toBe('failed');
    expect(doc.last_error).toMatch(/binary|UTF-8/i);
    expect(doc.versions[0].status).toBe('failed');

    // Retry is idempotent and does not duplicate chunks.
    const jobId = doc.jobs[0].id;
    await h.request(h.getApp()).post(`/api/jobs/${jobId}/retry`).expect(202);
    const after = await h.waitForIndexing(docId);
    expect(after.status).toBe('failed');
    const { rows } = await h.query('SELECT COUNT(*)::int AS n FROM document_chunks WHERE document_id = $1', [docId]);
    expect(rows[0].n).toBe(0);
  });

  it('re-indexes a document without duplicating chunks', async () => {
    const docId = await h.uploadAndIndex(project.id, 'reindex.txt', 'Idempotent indexing check content.');
    const before = (await h.query('SELECT COUNT(*)::int AS n FROM document_chunks WHERE document_id = $1', [docId])).rows[0].n;
    await h.request(h.getApp()).post(`/api/documents/${docId}/reindex`).send({}).expect(202);
    await h.waitForIndexing(docId);
    const after = (await h.query('SELECT COUNT(*)::int AS n FROM document_chunks WHERE document_id = $1', [docId])).rows[0].n;
    expect(after).toBe(before);
  });

  it('soft-deletes then permanently deletes a document and its chunks', async () => {
    const docId = await h.uploadAndIndex(project.id, 'disposable.txt', 'Temporary content for deletion.');
    await h.request(h.getApp()).delete(`/api/documents/${docId}`).expect(200);
    const { rows: chunksAfterSoft } = await h.query('SELECT COUNT(*)::int AS n FROM document_chunks WHERE document_id = $1', [docId]);
    expect(chunksAfterSoft[0].n).toBeGreaterThan(0); // history kept while archived
    const archived = await h.request(h.getApp()).get(`/api/projects/${project.id}/documents?includeArchived=true`).expect(200);
    expect(archived.body.documents[0].archived).toBe(true);

    await h.request(h.getApp()).delete(`/api/documents/${docId}?permanent=true`).expect(200);
    const { rows: chunksAfterHard } = await h.query('SELECT COUNT(*)::int AS n FROM document_chunks WHERE document_id = $1', [docId]);
    expect(chunksAfterHard[0].n).toBe(0);
    await h.request(h.getApp()).get(`/api/documents/${docId}`).expect(404);
  });

  it('runs the ingestion job asynchronously and reports progress fields', async () => {
    const res = await h.uploadFile(project.id, 'async.txt', 'Asynchronous ingestion payload.');
    expect(res.status).toBe(202);
    const { documentId, jobId } = res.body.results[0];
    expect(jobId).toBeTruthy();
    const { rows } = await h.query('SELECT status FROM ingestion_jobs WHERE id = $1', [jobId]);
    expect(['queued', 'processing', 'completed']).toContain(rows[0].status);
    const doc = await h.waitForIndexing(documentId);
    expect(doc.status).toBe('indexed');
  });

  it('filters and searches the document list', async () => {
    await h.uploadAndIndex(project.id, 'alpha-spec.md', '# Alpha\n\nAlpha specific content.');
    await h.uploadAndIndex(project.id, 'beta-spec.md', '# Beta\n\nBeta specific content.');
    const searched = await h.request(h.getApp()).get(`/api/projects/${project.id}/documents?search=alpha`).expect(200);
    expect(searched.body.documents).toHaveLength(1);
    expect(searched.body.documents[0].title).toContain('alpha-spec');
    const indexed = await h.request(h.getApp()).get(`/api/projects/${project.id}/documents?status=indexed`).expect(200);
    expect(indexed.body.total).toBe(2);
  });
});
