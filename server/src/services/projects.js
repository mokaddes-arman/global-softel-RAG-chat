'use strict';

const { query, withTransaction } = require('../db');
const { AppError, Codes } = require('../lib/errors');
const { slugify, slugSuffix } = require('../lib/ids');

const PROJECT_COLUMNS = `id, name, slug, description, instructions, status, settings, created_at, updated_at`;

async function listProjects({ includeArchived = false } = {}) {
  const { rows } = await query(
    `SELECT ${PROJECT_COLUMNS} FROM projects
     ${includeArchived ? '' : "WHERE status = 'active'"}
     ORDER BY name ASC`,
  );
  return rows;
}

async function getProject(id) {
  const { rows } = await query(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function requireProject(id) {
  const project = await getProject(id);
  if (!project) throw new AppError('Project not found.', { code: Codes.NOT_FOUND, status: 404 });
  return project;
}

/** Create a project, guaranteeing a unique slug even for duplicate names. */
async function createProject({ name, description = null, instructions = null, settings = {} }) {
  const base = slugify(name, 'project');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${slugSuffix()}`;
    try {
      const { rows } = await query(
        `INSERT INTO projects (name, slug, description, instructions, settings)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING ${PROJECT_COLUMNS}`,
        [name.trim(), slug, description, instructions, JSON.stringify(settings)],
      );
      return rows[0];
    } catch (err) {
      if (err.code === '23505' || /unique/i.test(err.message)) continue; // slug collision, retry
      throw err;
    }
  }
  throw new AppError('Could not generate a unique project slug.', { code: Codes.CONFLICT, status: 409 });
}

async function updateProject(id, { name, description, instructions, status, settings }) {
  const sets = [];
  const params = [];
  if (name !== undefined) sets.push(`name = $${params.push(name.trim())}`);
  if (description !== undefined) sets.push(`description = $${params.push(description)}`);
  if (instructions !== undefined) sets.push(`instructions = $${params.push(instructions)}`);
  if (status !== undefined) sets.push(`status = $${params.push(status)}`);
  if (settings !== undefined) sets.push(`settings = $${params.push(JSON.stringify(settings))}::jsonb`);
  if (!sets.length) return requireProject(id);
  params.push(id);
  const { rows } = await query(
    `UPDATE projects SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${PROJECT_COLUMNS}`,
    params,
  );
  if (!rows[0]) throw new AppError('Project not found.', { code: Codes.NOT_FOUND, status: 404 });
  return rows[0];
}

const archiveProject = (id) => updateProject(id, { status: 'archived' });
const restoreProject = (id) => updateProject(id, { status: 'active' });

/**
 * Delete a project and everything inside it. ON DELETE CASCADE removes
 * documents, versions, chunks, jobs, conversations and messages. Stored files
 * are removed by the caller (documents service) before this runs, because the
 * database must never be the only record of where a file lives.
 */
async function deleteProject(id) {
  await requireProject(id);
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(`DELETE FROM projects WHERE id = $1 RETURNING id, name, slug`, [id]);
    return rows[0];
  });
}

/** Project dashboard statistics, all computed from real data. */
async function projectStats(projectId) {
  const { rows } = await query(
    `
    WITH doc_stats AS (
      SELECT
        COUNT(*) FILTER (WHERE NOT archived) AS total_documents,
        COUNT(*) FILTER (WHERE NOT archived AND status = 'indexed') AS indexed_documents,
        COUNT(*) FILTER (WHERE NOT archived AND status IN ('pending','processing')) AS processing_documents,
        COUNT(*) FILTER (WHERE NOT archived AND status = 'failed') AS failed_documents,
        COUNT(*) FILTER (WHERE archived) AS archived_documents
      FROM documents WHERE project_id = $1
    ),
    chunk_stats AS (
      SELECT COUNT(*) AS total_chunks,
             COALESCE(SUM(token_count), 0) AS total_tokens
      FROM document_chunks WHERE project_id = $1
    ),
    conv_stats AS (
      SELECT COUNT(*) AS total_conversations,
             COUNT(*) FILTER (WHERE updated_at > now() - interval '7 days') AS recent_conversations
      FROM conversations WHERE project_id = $1 AND archived = false
    ),
    job_stats AS (
      SELECT COUNT(*) FILTER (WHERE status = 'queued') AS queued_jobs,
             COUNT(*) FILTER (WHERE status = 'processing') AS running_jobs,
             COUNT(*) FILTER (WHERE status = 'failed') AS failed_jobs
      FROM ingestion_jobs WHERE project_id = $1
    ),
    version_stats AS (
      SELECT COUNT(*) AS total_versions FROM document_versions WHERE project_id = $1
    ),
    recent_uploads AS (
      SELECT d.id, d.title, d.original_filename, d.file_ext, d.status, d.size_bytes, d.created_at,
             (SELECT COUNT(*) FROM document_chunks c WHERE c.document_id = d.id) AS chunk_count
      FROM documents d WHERE d.project_id = $1 AND NOT d.archived
      ORDER BY d.created_at DESC LIMIT 8
    ),
    recent_conversations AS (
      SELECT id, title, updated_at, created_at FROM conversations
      WHERE project_id = $1 AND archived = false ORDER BY updated_at DESC LIMIT 8
    ),
    storage AS (
      SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes FROM document_versions WHERE project_id = $1
    )
    SELECT
      (SELECT row_to_json(doc_stats) FROM doc_stats) AS documents,
      (SELECT row_to_json(chunk_stats) FROM chunk_stats) AS chunks,
      (SELECT row_to_json(conv_stats) FROM conv_stats) AS conversations,
      (SELECT row_to_json(job_stats) FROM job_stats) AS jobs,
      (SELECT row_to_json(version_stats) FROM version_stats) AS versions,
      (SELECT COALESCE(json_agg(row_to_json(recent_uploads)), '[]'::json) FROM recent_uploads) AS recent_uploads,
      (SELECT COALESCE(json_agg(row_to_json(recent_conversations)), '[]'::json) FROM recent_conversations) AS recent_conversations,
      (SELECT row_to_json(storage) FROM storage) AS storage
    `,
    [projectId],
  );
  const r = rows[0] || {};
  return {
    documents: r.documents || {},
    chunks: r.chunks || {},
    conversations: r.conversations || {},
    jobs: r.jobs || {},
    versions: r.versions || {},
    recentUploads: r.recent_uploads || [],
    recentConversations: r.recent_conversations || [],
    storage: r.storage || { total_bytes: 0 },
  };
}

module.exports = {
  listProjects,
  getProject,
  requireProject,
  createProject,
  updateProject,
  archiveProject,
  restoreProject,
  deleteProject,
  projectStats,
};
