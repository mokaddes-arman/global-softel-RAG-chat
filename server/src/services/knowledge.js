'use strict';

const { query, withTransaction } = require('../db');
const { AppError, Codes } = require('../lib/errors');
const { newId } = require('../lib/ids');
const documents = require('./documents');
const { parseUrl, canonicalUrl } = require('../crawl/fetcher');

/**
 * The knowledge-base service.
 *
 * Everything that is not a plain file upload lives here: web links, link
 * lists, collections and the crawl jobs that fetch a page and turn it into a
 * document. The service only touches the database and queues work; the crawl
 * worker does the fetching.
 */

const LINK_STATUSES = new Set(['pending', 'crawling', 'indexed', 'failed', 'archived']);

/* -------------------------------------------------------------------------- */
/* Collections                                                                */
/* -------------------------------------------------------------------------- */

async function listCollections(projectId) {
  const { rows } = await query(
    `SELECT c.*,
            (SELECT COUNT(*)::int FROM collection_items i WHERE i.collection_id = c.id AND i.document_id IS NOT NULL) AS document_count,
            (SELECT COUNT(*)::int FROM collection_items i WHERE i.collection_id = c.id AND i.web_link_id IS NOT NULL) AS link_count,
            (SELECT COUNT(*)::int FROM collection_items i WHERE i.collection_id = c.id) AS item_count
     FROM collections c
     WHERE c.project_id = $1
     ORDER BY c.name ASC`,
    [projectId],
  );
  return rows;
}

async function getCollection(id) {
  const { rows } = await query('SELECT * FROM collections WHERE id = $1', [id]);
  if (!rows[0]) throw new AppError('Collection not found.', { code: Codes.NOT_FOUND, status: 404 });
  return rows[0];
}

async function getCollectionItems(collectionId) {
  const { rows } = await query(
    `SELECT i.id, i.added_at, i.document_id, i.web_link_id,
            d.title AS document_title, d.original_filename, d.status AS document_status,
            l.url AS link_url, l.title AS link_title, l.status AS link_status
     FROM collection_items i
     LEFT JOIN documents d ON d.id = i.document_id
     LEFT JOIN web_links l ON l.id = i.web_link_id
     WHERE i.collection_id = $1
     ORDER BY i.added_at ASC`,
    [collectionId],
  );
  return rows;
}

async function createCollection(projectId, { name, description = null }) {
  const clean = String(name || '').trim();
  if (!clean) throw new AppError('A collection name is required.', { code: Codes.VALIDATION, status: 422 });
  const id = newId();
  const { rows } = await query(
    `INSERT INTO collections (id, project_id, name, description) VALUES ($1,$2,$3,$4) RETURNING *`,
    [id, projectId, clean.slice(0, 200), description ? String(description).slice(0, 2000) : null],
  );
  return rows[0];
}

async function updateCollection(id, patch = {}) {
  const collection = await getCollection(id);
  const sets = [];
  const params = [];
  if (patch.name !== undefined) {
    const name = String(patch.name || '').trim();
    if (!name) throw new AppError('A collection name is required.', { code: Codes.VALIDATION, status: 422 });
    sets.push(`name = $${params.push(name.slice(0, 200))}`);
  }
  if (patch.description !== undefined) {
    sets.push(`description = $${params.push(patch.description ? String(patch.description).slice(0, 2000) : null)}`);
  }
  if (!sets.length) return collection;
  params.push(id);
  const { rows } = await query(`UPDATE collections SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  return rows[0];
}

async function deleteCollection(id) {
  await getCollection(id);
  await query('DELETE FROM collections WHERE id = $1', [id]);
  return { deleted: true, id };
}

/** Add documents and/or web links to a collection (duplicates are ignored). */
async function addCollectionItems(collectionId, { documentIds = [], webLinkIds = [] } = {}) {
  const collection = await getCollection(collectionId);
  const added = { documents: 0, links: 0 };

  for (const documentId of documentIds) {
    const { rows } = await query('SELECT id FROM documents WHERE id = $1 AND project_id = $2', [documentId, collection.project_id]);
    if (!rows[0]) continue;
    const res = await query(
      `INSERT INTO collection_items (id, collection_id, document_id) VALUES ($1,$2,$3)
       ON CONFLICT (collection_id, document_id) WHERE document_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [newId(), collectionId, documentId],
    );
    if (res.rows.length) added.documents += 1;
  }

  for (const webLinkId of webLinkIds) {
    const { rows } = await query('SELECT id FROM web_links WHERE id = $1 AND project_id = $2', [webLinkId, collection.project_id]);
    if (!rows[0]) continue;
    const res = await query(
      `INSERT INTO collection_items (id, collection_id, web_link_id) VALUES ($1,$2,$3)
       ON CONFLICT (collection_id, web_link_id) WHERE web_link_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [newId(), collectionId, webLinkId],
    );
    if (res.rows.length) added.links += 1;
  }

  return added;
}

async function removeCollectionItem(collectionId, itemId) {
  const { rows } = await query('DELETE FROM collection_items WHERE id = $1 AND collection_id = $2 RETURNING id', [
    itemId,
    collectionId,
  ]);
  if (!rows[0]) throw new AppError('That collection item does not exist.', { code: Codes.NOT_FOUND, status: 404 });
  return { deleted: true, id: itemId };
}

/* -------------------------------------------------------------------------- */
/* Web links                                                                  */
/* -------------------------------------------------------------------------- */

async function listWebLinks(projectId, { search, status, collectionId, limit = 100, offset = 0 } = {}) {
  const conditions = ['l.project_id = $1'];
  const params = [projectId];
  if (status && LINK_STATUSES.has(status)) conditions.push(`l.status = $${params.push(status)}`);
  if (collectionId) conditions.push(`l.collection_id = $${params.push(collectionId)}`);
  if (search) {
    const pattern = params.push(`%${search}%`);
    conditions.push(`(l.url ILIKE $${pattern} OR l.title ILIKE $${pattern})`);
  }
  const limitParam = params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const offsetParam = params.push(Math.max(Number(offset) || 0, 0));

  const { rows } = await query(
    `SELECT l.*, c.name AS collection_name,
            (SELECT COUNT(*)::int FROM crawl_jobs j WHERE j.web_link_id = l.id) AS crawl_job_count,
            (SELECT COUNT(*)::int FROM document_chunks ch WHERE ch.document_id = l.document_id) AS chunk_count
     FROM web_links l
     LEFT JOIN collections c ON c.id = l.collection_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY l.created_at DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );
  return rows;
}

async function getWebLink(id) {
  const { rows } = await query('SELECT * FROM web_links WHERE id = $1', [id]);
  if (!rows[0]) throw new AppError('Web link not found.', { code: Codes.NOT_FOUND, status: 404 });
  return rows[0];
}

/**
 * Register one or more URLs as knowledge-base links and queue a crawl for
 * each of them. Invalid URLs are reported individually instead of failing
 * the whole batch.
 */
async function createWebLinks(projectId, rawUrls, { collectionId = null, linkListId = null, title = null } = {}) {
  const list = Array.isArray(rawUrls) ? rawUrls : [rawUrls];
  const created = [];
  const errors = [];
  const skipped = [];

  for (const raw of list) {
    let url;
    let canonical;
    try {
      url = parseUrl(raw);
      canonical = canonicalUrl(url);
    } catch (err) {
      errors.push({ url: String(raw || ''), message: err.message, code: err.code || Codes.VALIDATION });
      continue;
    }

    const existing = await query('SELECT id FROM web_links WHERE project_id = $1 AND canonical_url = $2', [projectId, canonical]);
    if (existing.rows[0]) {
      skipped.push({ url: canonical, id: existing.rows[0].id, reason: 'already_in_knowledge_base' });
      continue;
    }

    const linkId = newId();
    const jobId = newId();
    try {
      await withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO web_links (id, project_id, url, canonical_url, title, status, collection_id, link_list_id)
           VALUES ($1,$2,$3,$4,$5,'pending',$6,$7)`,
          [linkId, projectId, url.toString(), canonical, title ? String(title).slice(0, 300) : null, collectionId, linkListId],
        );
        await tx.query(
          `INSERT INTO crawl_jobs (id, project_id, web_link_id, job_type, status, stage, max_attempts)
           VALUES ($1,$2,$3,'crawl','queued','queued',$4)`,
          [jobId, projectId, linkId, 3],
        );
      });
    } catch (err) {
      errors.push({ url: canonical, message: err.message, code: err.code || 'link_failed' });
      continue;
    }

    created.push({ id: linkId, url: url.toString(), canonicalUrl: canonical, jobId });
  }

  if (created.length) {
    const { notifyWorker } = require('../crawl/worker');
    notifyWorker();
  }

  return { created, errors, skipped };
}

async function updateWebLink(id, patch = {}) {
  const link = await getWebLink(id);
  const sets = [];
  const params = [];
  if (patch.title !== undefined) {
    sets.push(`title = $${params.push(patch.title ? String(patch.title).slice(0, 300) : null)}`);
  }
  if (patch.collectionId !== undefined) {
    if (patch.collectionId) {
      const { rows } = await query('SELECT id FROM collections WHERE id = $1 AND project_id = $2', [patch.collectionId, link.project_id]);
      if (!rows[0]) throw new AppError('Collection not found.', { code: Codes.NOT_FOUND, status: 404 });
    }
    sets.push(`collection_id = $${params.push(patch.collectionId || null)}`);
  }
  if (!sets.length) return link;
  params.push(id);
  const { rows } = await query(`UPDATE web_links SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  return rows[0];
}

/** Remove a link. The document it produced is archived, not destroyed. */
async function deleteWebLink(id) {
  const link = await getWebLink(id);
  await withTransaction(async (tx) => {
    await tx.query(`UPDATE crawl_jobs SET status = 'cancelled', finished_at = now() WHERE web_link_id = $1 AND status IN ('queued','processing')`, [
      id,
    ]);
    await tx.query('DELETE FROM collection_items WHERE web_link_id = $1', [id]);
    await tx.query('DELETE FROM web_links WHERE id = $1', [id]);
  });
  if (link.document_id) {
    await documents.archiveDocument(link.document_id).catch(() => {});
  }
  return { deleted: true, id };
}

/** Queue a fresh crawl of an existing link (a "re-crawl"). */
async function recrawlWebLink(id) {
  const link = await getWebLink(id);
  const jobId = newId();
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE crawl_jobs SET status = 'cancelled', finished_at = now() WHERE web_link_id = $1 AND status IN ('queued','processing')`,
      [id],
    );
    await tx.query(
      `INSERT INTO crawl_jobs (id, project_id, web_link_id, job_type, status, stage, max_attempts)
       VALUES ($1,$2,$3,'recrawl','queued','queued',$4)`,
      [jobId, link.project_id, id, 3],
    );
    await tx.query(`UPDATE web_links SET status = 'pending', last_error = NULL WHERE id = $1`, [id]);
  });
  const { notifyWorker } = require('../crawl/worker');
  notifyWorker();
  return { jobId, linkId: id, status: 'queued' };
}

/* -------------------------------------------------------------------------- */
/* Link lists                                                                 */
/* -------------------------------------------------------------------------- */

async function listLinkLists(projectId) {
  const { rows } = await query(
    `SELECT l.*, (SELECT COUNT(*)::int FROM link_list_items i WHERE i.link_list_id = l.id) AS item_count
     FROM link_lists l
     WHERE l.project_id = $1
     ORDER BY l.updated_at DESC`,
    [projectId],
  );
  return rows;
}

async function getLinkList(id) {
  const { rows } = await query('SELECT * FROM link_lists WHERE id = $1', [id]);
  if (!rows[0]) throw new AppError('Link list not found.', { code: Codes.NOT_FOUND, status: 404 });
  return rows[0];
}

async function listLinkListItems(linkListId) {
  const { rows } = await query(
    `SELECT i.*, (SELECT l.id FROM web_links l WHERE l.canonical_url = i.url AND l.project_id = $2) AS web_link_id
     FROM link_list_items i
     WHERE i.link_list_id = $1
     ORDER BY i.position ASC, i.created_at ASC`,
    [linkListId, (await getLinkList(linkListId)).project_id],
  );
  return rows;
}

/** Split a pasted block of text into individual URLs. */
function splitUrls(text) {
  return String(text || '')
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function createLinkList(projectId, { name, description = null, urls = [] }) {
  const clean = String(name || '').trim();
  if (!clean) throw new AppError('A link list name is required.', { code: Codes.VALIDATION, status: 422 });
  const id = newId();
  await withTransaction(async (tx) => {
    await tx.query(`INSERT INTO link_lists (id, project_id, name, description) VALUES ($1,$2,$3,$4)`, [
      id,
      projectId,
      clean.slice(0, 200),
      description ? String(description).slice(0, 2000) : null,
    ]);
    await insertListItems(tx, id, urls);
  });
  return getLinkList(id);
}

async function insertListItems(tx, linkListId, urls) {
  let position = 0;
  let added = 0;
  for (const raw of urls) {
    let canonical;
    try {
      canonical = canonicalUrl(raw);
    } catch {
      continue; // an invalid URL never reaches the database
    }
    const res = await tx.query(
      `INSERT INTO link_list_items (id, link_list_id, url, position) VALUES ($1,$2,$3,$4)
       ON CONFLICT (link_list_id, url) DO NOTHING RETURNING id`,
      [newId(), linkListId, canonical, position],
    );
    if (res.rows.length) {
      added += 1;
      position += 1;
    }
  }
  return added;
}

async function addLinkListItems(linkListId, urls) {
  const list = await getLinkList(linkListId);
  const added = await withTransaction(async (tx) => insertListItems(tx, linkListId, urls));
  return { listId: list.id, added };
}

async function deleteLinkList(id) {
  await getLinkList(id);
  await query('DELETE FROM link_lists WHERE id = $1', [id]);
  return { deleted: true, id };
}

/**
 * Turn every URL of a list into a knowledge-base link and queue a crawl.
 */
async function importLinkList(linkListId, { collectionId = null } = {}) {
  const list = await getLinkList(linkListId);
  const items = await listLinkListItems(linkListId);
  const urls = items.map((i) => i.url);
  const result = await createWebLinks(list.project_id, urls, { collectionId, linkListId });
  return { linkListId, total: urls.length, ...result };
}

/* -------------------------------------------------------------------------- */
/* Crawl jobs                                                                 */
/* -------------------------------------------------------------------------- */

async function listCrawlJobs(projectId, { status, limit = 50 } = {}) {
  const conditions = ['j.project_id = $1'];
  const params = [projectId];
  if (status) conditions.push(`j.status = $${params.push(status)}`);
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const { rows } = await query(
    `SELECT j.*, l.url, l.title AS link_title
     FROM crawl_jobs j
     JOIN web_links l ON l.id = j.web_link_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY j.created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows;
}

async function retryCrawlJob(jobId) {
  const { rows } = await query('SELECT * FROM crawl_jobs WHERE id = $1', [jobId]);
  const job = rows[0];
  if (!job) throw new AppError('Crawl job not found.', { code: Codes.NOT_FOUND, status: 404 });
  if (job.status === 'processing') {
    throw new AppError('That crawl job is currently running.', { code: Codes.CONFLICT, status: 409 });
  }
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE crawl_jobs SET status = 'queued', stage = 'queued', progress = 0, error = NULL, error_code = NULL,
              started_at = NULL, finished_at = NULL WHERE id = $1`,
      [jobId],
    );
    await tx.query(`UPDATE web_links SET status = 'pending', last_error = NULL WHERE id = $1`, [job.web_link_id]);
  });
  const { notifyWorker } = require('../crawl/worker');
  notifyWorker();
  return { retried: true, jobId };
}

module.exports = {
  listCollections,
  getCollection,
  getCollectionItems,
  createCollection,
  updateCollection,
  deleteCollection,
  addCollectionItems,
  removeCollectionItem,
  listWebLinks,
  getWebLink,
  createWebLinks,
  updateWebLink,
  deleteWebLink,
  recrawlWebLink,
  listLinkLists,
  getLinkList,
  listLinkListItems,
  createLinkList,
  addLinkListItems,
  deleteLinkList,
  importLinkList,
  listCrawlJobs,
  retryCrawlJob,
  splitUrls,
};
