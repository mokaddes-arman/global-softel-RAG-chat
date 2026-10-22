/* globals describe, it, expect, beforeAll, afterAll, beforeEach, afterEach */
const http = require('node:http');
const h = require('../helpers');

/**
 * A tiny local web server that serves one HTML page. The crawler fetches it
 * exactly like it would fetch a public documentation page.
 */
function startFixtureServer(html = '<html><body><h1>Fixture</h1><p>Crawled content.</p></body></html>') {
  const server = http.createServer((req, res) => {
    if (req.url === '/missing') {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><body>not found</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

describe('knowledge base (web links, link lists, collections, crawl jobs)', () => {
  let project;
  let fixture;

  beforeAll(async () => {
    await h.setupTestApp();
    fixture = await startFixtureServer(
      '<html><head><title>Fixture Page</title></head><body>' +
        '<h1>Fixture Page</h1>' +
        '<p>The deployment window is <strong>Sunday 02:00 UTC</strong>.</p>' +
        '<ul><li>First bullet</li><li>Second bullet</li></ul>' +
        '</body></html>',
    );
  });

  afterAll(async () => {
    if (fixture) await new Promise((resolve) => fixture.server.close(resolve));
    await h.teardownTestApp();
  });

  beforeEach(async () => {
    await h.resetData();
    project = await h.createProject('Knowledge');
  });

  /* ---------------------------------------------------------------------- */
  /* collections                                                            */
  /* ---------------------------------------------------------------------- */

  it('creates, lists, updates and deletes a collection', async () => {
    const created = await h.request(h.getApp())
      .post(`/api/projects/${project.id}/collections`)
      .send({ name: 'Release notes', description: 'Everything about releases' })
      .expect(201);
    expect(created.body.collection.name).toBe('Release notes');

    const list = await h.request(h.getApp()).get(`/api/projects/${project.id}/collections`).expect(200);
    expect(list.body.collections).toHaveLength(1);
    expect(list.body.collections[0].item_count).toBe(0);

    const patched = await h.request(h.getApp())
      .patch(`/api/collections/${created.body.collection.id}`)
      .send({ name: 'Release notes 2026' })
      .expect(200);
    expect(patched.body.collection.name).toBe('Release notes 2026');

    await h.request(h.getApp()).delete(`/api/collections/${created.body.collection.id}`).expect(200);
    const after = await h.request(h.getApp()).get(`/api/projects/${project.id}/collections`).expect(200);
    expect(after.body.collections).toHaveLength(0);
  });

  it('collects documents and web links in one collection', async () => {
    const docId = await h.uploadAndIndex(project.id, 'notes.md', '# Notes\n\nSome release notes.');
    const collection = await h.request(h.getApp())
      .post(`/api/projects/${project.id}/collections`)
      .send({ name: 'Docs' })
      .expect(201);
    const collectionId = collection.body.collection.id;

    const linkRes = await h.request(h.getApp())
      .post(`/api/projects/${project.id}/links`)
      .send({ urls: [`${fixture.origin}/docs`] })
      .expect(202);
    const linkId = linkRes.body.created[0].id;

    const added = await h.request(h.getApp())
      .post(`/api/collections/${collectionId}/items`)
      .send({ documentIds: [docId], webLinkIds: [linkId] })
      .expect(201);
    expect(added.body.added.documents).toBe(1);
    expect(added.body.added.links).toBe(1);

    const items = await h.request(h.getApp()).get(`/api/collections/${collectionId}`).expect(200);
    expect(items.body.items).toHaveLength(2);
    expect(items.body.items.some((i) => i.document_id === docId)).toBe(true);
    expect(items.body.items.some((i) => i.web_link_id === linkId)).toBe(true);

    // The same item is never added twice.
    const again = await h.request(h.getApp())
      .post(`/api/collections/${collectionId}/items`)
      .send({ documentIds: [docId] })
      .expect(201);
    expect(again.body.added.documents).toBe(0);

    // A collection only accepts items of its own project.
    const other = await h.createProject('Other');
    const otherDoc = await h.uploadAndIndex(other.id, 'other.md', '# Other');
    const foreign = await h.request(h.getApp())
      .post(`/api/collections/${collectionId}/items`)
      .send({ documentIds: [otherDoc] })
      .expect(201);
    expect(foreign.body.added.documents).toBe(0);
  });

  /* ---------------------------------------------------------------------- */
  /* web links + crawling                                                   */
  /* ---------------------------------------------------------------------- */

  it('registers a web link, crawls it and indexes the page as a document', async () => {
    const res = await h.request(h.getApp())
      .post(`/api/projects/${project.id}/links`)
      .send({ urls: [`${fixture.origin}/page`] })
      .expect(202);
    expect(res.body.created).toHaveLength(1);
    const linkId = res.body.created[0].id;

    const link = await h.waitForCrawl(linkId);
    expect(link.status).toBe('indexed');
    expect(link.job_status).toBe('completed');
    expect(link.document_id).toBeTruthy();

    // The crawled page became a normal, indexed document.
    const doc = (await h.request(h.getApp()).get(`/api/documents/${link.document_id}`).expect(200)).body.document;
    expect(doc.status).toBe('indexed');
    expect(doc.file_ext).toBe('md');
    expect(doc.title).toBe('Fixture Page');
    expect(doc.versions[0].chunk_count).toBeGreaterThan(0);

    // The crawl job is listed for the project.
    const jobs = await h.request(h.getApp()).get(`/api/projects/${project.id}/crawl-jobs`).expect(200);
    expect(jobs.body.crawlJobs).toHaveLength(1);
    expect(jobs.body.crawlJobs[0].status).toBe('completed');
    expect(jobs.body.crawlJobs[0].job_type).toBe('crawl');
  });

  it('re-crawls a link and keeps the previous version', async () => {
    const res = await h.request(h.getApp())
      .post(`/api/projects/${project.id}/links`)
      .send({ urls: [`${fixture.origin}/page`] })
      .expect(202);
    const linkId = res.body.created[0].id;
    const first = await h.waitForCrawl(linkId);

    await h.request(h.getApp()).post(`/api/links/${linkId}/crawl`).expect(202);
    const second = await h.waitForCrawl(linkId);

    expect(second.crawl_count).toBe(first.crawl_count + 1);
    const doc = (await h.request(h.getApp()).get(`/api/documents/${second.document_id}`).expect(200)).body.document;
    expect(doc.versions).toHaveLength(2);
    expect(doc.versions.filter((v) => v.is_active)).toHaveLength(1);
    expect(doc.versions.find((v) => v.is_active).version_number).toBe(2);
    expect(doc.versions.find((v) => v.version_number === 1).status).toBe('superseded');

    const jobs = await h.request(h.getApp()).get(`/api/projects/${project.id}/crawl-jobs`).expect(200);
    expect(jobs.body.crawlJobs.map((j) => j.job_type)).toContain('recrawl');
  });

  it('reports an invalid URL per entry instead of failing the whole batch', async () => {
    const res = await h.request(h.getApp())
      .post(`/api/projects/${project.id}/links`)
      .send({ urls: ['not a url at all', 'ftp://example.com/file'] })
      .expect(400);
    expect(res.body.created).toHaveLength(0);
    expect(res.body.errors).toHaveLength(2);
    expect(res.body.errors[0].url).toBe('not a url at all');
  });

  it('never registers the same link twice', async () => {
    const url = `${fixture.origin}/page`;
    await h.request(h.getApp()).post(`/api/projects/${project.id}/links`).send({ urls: [url] }).expect(202);
    const second = await h.request(h.getApp())
      .post(`/api/projects/${project.id}/links`)
      .send({ urls: [url] })
      .expect(200);
    expect(second.body.created).toHaveLength(0);
    expect(second.body.skipped).toHaveLength(1);
    expect(second.body.skipped[0].reason).toBe('already_in_knowledge_base');
  });

  it('marks a link as failed when the page cannot be fetched', async () => {
    const res = await h.request(h.getApp())
      .post(`/api/projects/${project.id}/links`)
      .send({ urls: [`${fixture.origin}/missing`] })
      .expect(202);
    const linkId = res.body.created[0].id;
    const link = await h.waitForCrawl(linkId);
    expect(link.status).toBe('failed');
    expect(link.last_error).toBeTruthy();

    // A failed crawl can be retried.
    const jobs = await h.request(h.getApp()).get(`/api/projects/${project.id}/crawl-jobs?status=failed`).expect(200);
    expect(jobs.body.crawlJobs).toHaveLength(1);
    await h.request(h.getApp()).post(`/api/crawl-jobs/${jobs.body.crawlJobs[0].id}/retry`).expect(202);
  });

  /* ---------------------------------------------------------------------- */
  /* link lists                                                             */
  /* ---------------------------------------------------------------------- */

  it('creates a link list, adds URLs to it and imports it into the knowledge base', async () => {
    const created = await h.request(h.getApp())
      .post(`/api/projects/${project.id}/link-lists`)
      .send({
        name: 'Reference set',
        description: 'Public documentation',
        urls: [`${fixture.origin}/a`, `${fixture.origin}/b`],
      })
      .expect(201);
    const listId = created.body.linkList.id;

    const detail = await h.request(h.getApp()).get(`/api/link-lists/${listId}`).expect(200);
    expect(detail.body.items).toHaveLength(2);

    await h.request(h.getApp())
      .post(`/api/link-lists/${listId}/items`)
      .send({ urls: [`${fixture.origin}/c`] })
      .expect(201);
    const afterAdd = await h.request(h.getApp()).get(`/api/link-lists/${listId}`).expect(200);
    expect(afterAdd.body.items).toHaveLength(3);

    const imported = await h.request(h.getApp()).post(`/api/link-lists/${listId}/import`).send({}).expect(202);
    expect(imported.body.created).toHaveLength(3);

    const links = await h.request(h.getApp()).get(`/api/projects/${project.id}/links`).expect(200);
    expect(links.body.links).toHaveLength(3);
  });

  it('deletes a link list', async () => {
    const created = await h.request(h.getApp())
      .post(`/api/projects/${project.id}/link-lists`)
      .send({ name: 'Temporary' })
      .expect(201);
    await h.request(h.getApp()).delete(`/api/link-lists/${created.body.linkList.id}`).expect(200);
    const lists = await h.request(h.getApp()).get(`/api/projects/${project.id}/link-lists`).expect(200);
    expect(lists.body.linkLists).toHaveLength(0);
  });

  /* ---------------------------------------------------------------------- */
  /* markdown export                                                        */
  /* ---------------------------------------------------------------------- */

  it('shares a document as a downloadable markdown file', async () => {
    const docId = await h.uploadAndIndex(project.id, 'shared.md', '# Shared\n\nThe window is Sunday 02:00 UTC.');

    const preview = await h.request(h.getApp()).get(`/api/documents/${docId}/markdown`).expect(200);
    expect(preview.body.markdown.filename).toBe('shared.md');
    expect(preview.body.markdown.markdown).toContain('# Shared');
    expect(preview.body.markdown.markdown).toContain('Sunday 02:00 UTC');
    expect(preview.body.markdown.markdown.startsWith('---')).toBe(true);

    const download = await h.request(h.getApp()).get(`/api/documents/${docId}/markdown/download`).expect(200);
    expect(download.headers['content-type']).toContain('text/markdown');
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['content-disposition']).toContain('shared.md');
    expect(download.text).toContain('# Shared');
  });

  it('shares a crawled page as markdown with its source url', async () => {
    const res = await h.request(h.getApp())
      .post(`/api/projects/${project.id}/links`)
      .send({ urls: [`${fixture.origin}/page`] })
      .expect(202);
    const link = await h.waitForCrawl(res.body.created[0].id);

    const preview = await h.request(h.getApp()).get(`/api/documents/${link.document_id}/markdown`).expect(200);
    expect(preview.body.markdown.markdown).toContain('url:');
    expect(preview.body.markdown.markdown).toContain('The deployment window is');
    expect(preview.body.markdown.sourceUrl).toContain(fixture.origin);
  });
});
