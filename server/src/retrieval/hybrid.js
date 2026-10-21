'use strict';

const { query } = require('../db');
const { config } = require('../config/env');
const { logger } = require('../lib/logger');
const { embedTexts } = require('../embeddings');
const { describeLocation } = require('../llm/prompt');

/**
 * Hybrid retrieval: semantic (pgvector cosine) + keyword (PostgreSQL full-text),
 * fused with Reciprocal Rank Fusion, optionally re-scored by a lexical
 * coverage reranker.
 *
 * Project isolation is enforced in SQL for every query - there is no code path
 * that can return another project's chunks unless the caller explicitly passes
 * a cross-project scope.
 */

const RRF_K = 60;

function toVectorLiteral(vec) {
  // pgvector accepts the textual '[a,b,c]' representation and casts it.
  return `[${vec.map((v) => (Number.isFinite(v) ? Number(v.toFixed(6)) : 0)).join(',')}]`;
}

function buildScopeClause({ projectIds, includeHistoricalVersions, modelId }) {
  const params = [];
  const conditions = [];

  conditions.push(`c.project_id = ANY($${params.push(projectIds)}::uuid[])`);
  conditions.push(`c.embedding_model_id = $${params.push(modelId)}::uuid`);
  conditions.push(`c.embedding IS NOT NULL`);
  conditions.push(`d.archived = false`);
  conditions.push(`v.status IN ('indexed'${includeHistoricalVersions ? ",'superseded'" : ''})`);
  conditions.push(`v.is_active = ${includeHistoricalVersions ? 'v.is_active' : 'true'}`);

  return { conditions, params };
}

async function vectorSearch({ queryEmbedding, projectIds, modelId, limit, includeHistoricalVersions, minScore }) {
  const { conditions, params } = buildScopeClause({ projectIds, includeHistoricalVersions, modelId });
  const vecParam = params.push(toVectorLiteral(queryEmbedding));
  const limitParam = params.push(limit);

  const sql = `
    SELECT c.id, c.project_id, c.document_id, c.document_version_id, c.chunk_index, c.content,
           c.metadata, c.token_count,
           d.title AS document_title, v.version_number, v.uploaded_at AS version_uploaded_at,
           v.is_active, v.file_ext,
           1 - (c.embedding <=> $${vecParam}::vector) AS score
    FROM document_chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN document_versions v ON v.id = c.document_version_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY c.embedding <=> $${vecParam}::vector
    LIMIT $${limitParam}
  `;
  const { rows } = await query(sql, params);
  return rows
    .map((r) => ({ ...r, score: Number(r.score) }))
    .filter((r) => (minScore ? r.score >= minScore : true));
}

async function keywordSearch({ queryText, projectIds, modelId, limit, includeHistoricalVersions }) {
  const { conditions, params } = buildScopeClause({ projectIds, includeHistoricalVersions, modelId });
  const tsParam = params.push(queryText);
  const limitParam = params.push(limit);

  const sql = `
    SELECT c.id, c.project_id, c.document_id, c.document_version_id, c.chunk_index, c.content,
           c.metadata, c.token_count,
           d.title AS document_title, v.version_number, v.uploaded_at AS version_uploaded_at,
           v.is_active, v.file_ext,
           ts_rank_cd(c.search, websearch_to_tsquery('english', $${tsParam})) AS score
    FROM document_chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN document_versions v ON v.id = c.document_version_id
    WHERE ${conditions.join(' AND ')}
      AND c.search @@ websearch_to_tsquery('english', $${tsParam})
    ORDER BY score DESC
    LIMIT $${limitParam}
  `;
  const { rows } = await query(sql, params);
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}

/** Lexical coverage reranker: fraction of query terms present, weighted by rarity. */
function lexicalRerank(candidates, queryText) {
  const terms = String(queryText)
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return candidates;
  const unique = [...new Set(terms)];
  return candidates
    .map((c) => {
      const haystack = `${c.document_title} ${c.content}`.toLowerCase();
      let hits = 0;
      for (const t of unique) if (haystack.includes(t)) hits += 1;
      const coverage = hits / unique.length;
      return { ...c, rerankScore: coverage, fusedScore: c.fusedScore * (0.6 + 0.8 * coverage) };
    })
    .sort((a, b) => b.fusedScore - a.fusedScore);
}

/**
 * Fuse vector + keyword rankings using Reciprocal Rank Fusion.
 * Returns candidates ordered best-first with both ranks preserved.
 */
function fuse(vectorRows, keywordRows) {
  const byChunk = new Map();
  vectorRows.forEach((row, i) => {
    byChunk.set(row.id, {
      ...row,
      vectorScore: row.score,
      vectorRank: i + 1,
      keywordRank: null,
      fusedScore: 1 / (RRF_K + i + 1),
    });
  });
  keywordRows.forEach((row, i) => {
    const existing = byChunk.get(row.id);
    if (existing) {
      existing.keywordRank = i + 1;
      existing.fusedScore += 1 / (RRF_K + i + 1);
      existing.keywordScore = row.score;
    } else {
      byChunk.set(row.id, { ...row, vectorRank: null, keywordRank: i + 1, fusedScore: 1 / (RRF_K + i + 1) });
    }
  });
  return [...byChunk.values()].sort((a, b) => b.fusedScore - a.fusedScore);
}

/**
 * Drop vector-only candidates whose semantic similarity is far below the best
 * match. This honours the "do not pad the context with irrelevant chunks just
 * to fill a quota" requirement. Keyword hits are always kept: their presence
 * means the chunk literally contains query terms.
 */
function applyRelativeCutoff(candidates, relativeCutoff) {
  if (!relativeCutoff || relativeCutoff <= 0) return candidates;
  const scores = candidates.map((c) => c.vectorScore).filter((s) => Number.isFinite(s));
  if (!scores.length) return candidates;
  const best = Math.max(...scores);
  if (!(best > 0)) return candidates;
  const floor = best * relativeCutoff;
  return candidates.filter(
    (c) => c.keywordRank !== null || !Number.isFinite(c.vectorScore) || c.vectorScore >= floor,
  );
}

/** Convert a candidate row into the citation shape used by the UI and prompt. */
function toSource(candidate, rank) {
  const meta = candidate.metadata || {};
  const location = meta.location || {};
  return {
    chunkId: candidate.id,
    documentId: candidate.document_id,
    documentVersionId: candidate.document_version_id,
    documentTitle: candidate.document_title,
    documentVersionNumber: candidate.version_number,
    projectId: candidate.project_id,
    isActiveVersion: candidate.is_active,
    fileExt: candidate.file_ext,
    rank,
    chunkIndex: candidate.chunk_index,
    score: candidate.fusedScore,
    vectorScore: candidate.vectorScore ?? null,
    keywordScore: candidate.keywordScore ?? null,
    vectorRank: candidate.vectorRank,
    keywordRank: candidate.keywordRank,
    rerankScore: candidate.rerankScore ?? null,
    location,
    sourceLocation: describeLocation(location),
    excerpt: candidate.content,
  };
}

/** Count chunks that are eligible for retrieval in the given scope. */
async function scopedChunkCount({ projectIds, modelId, includeHistoricalVersions }) {
  const { conditions, params } = buildScopeClause({ projectIds, includeHistoricalVersions, modelId });
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n
     FROM document_chunks c
     JOIN documents d ON d.id = c.document_id
     JOIN document_versions v ON v.id = c.document_version_id
     WHERE ${conditions.join(' AND ')}`,
    params,
  );
  return rows[0]?.n ?? 0;
}

/**
 * Full retrieval for one question.
 *
 * @returns {Promise<{sources: object[], stats: object}>}
 */
async function retrieve({
  question,
  embedding,          // { provider, model, dimension, baseUrl, apiKey }
  modelId,            // embedding_models.id whose vectors to search
  projectIds,         // [uuid] - one project normally, many for cross-project
  settings = {},
  includeHistoricalVersions = false,
  signal,
}) {
  const started = Date.now();
  const topK = Math.max(1, Math.min(settings.topK ?? config.retrieval.topK, 50));
  const vectorCandidates = Math.max(topK, Math.min(settings.vectorCandidates ?? config.retrieval.vectorCandidates, 200));
  const keywordCandidates = Math.max(
    topK,
    Math.min(settings.keywordCandidates ?? config.retrieval.keywordCandidates, 200),
  );
  const minScore = settings.minScore ?? config.retrieval.minScore;
  const rerankEnabled = settings.rerankEnabled ?? config.retrieval.rerankEnabled;
  const relativeCutoff = settings.relativeCutoff ?? config.retrieval.relativeCutoff;

  if (!modelId) return { sources: [], stats: { reason: 'no_embedding_model' } };
  if (!projectIds?.length) return { sources: [], stats: { reason: 'no_projects' } };

  // Cheap short-circuit: if the scoped projects contain no indexed chunks at
  // all, there is nothing to search and no reason to call the embedding model.
  const scopedChunks = await scopedChunkCount({ projectIds, modelId, includeHistoricalVersions });
  if (scopedChunks === 0) {
    return {
      sources: [],
      stats: { reason: 'no_projects', scopedProjects: projectIds.length, scopedChunks: 0, returned: 0, topK },
    };
  }

  const embedMs0 = Date.now();
  const [queryEmbedding] = await embedTexts({ ...embedding, signal }, [question]);
  const embedMs = Date.now() - embedMs0;

  const t0 = Date.now();
  const [vectorRows, keywordRows] = await Promise.all([
    vectorSearch({ queryEmbedding, projectIds, modelId, limit: vectorCandidates, includeHistoricalVersions, minScore }).catch(
      (err) => {
        logger.error({ err: err.message }, 'vector search failed');
        throw err;
      },
    ),
    keywordSearch({ question, queryText: question, projectIds, modelId, limit: keywordCandidates, includeHistoricalVersions }).catch(
      (err) => {
        logger.warn({ err: err.message }, 'keyword search failed; continuing with vector results only');
        return [];
      },
    ),
  ]);
  const searchMs = Date.now() - t0;

  let candidates = fuse(vectorRows, keywordRows);
  candidates = applyRelativeCutoff(candidates, relativeCutoff);
  if (rerankEnabled && candidates.length) candidates = lexicalRerank(candidates, question);

  const selected = candidates.slice(0, topK);
  const sources = selected.map((c, i) => toSource(c, i + 1));

  const stats = {
    totalMs: Date.now() - started,
    embedMs,
    searchMs,
    vectorCount: vectorRows.length,
    keywordCount: keywordRows.length,
    fusedCount: candidates.length,
    returned: sources.length,
    rerankEnabled,
    relativeCutoff,
    topK,
    projects: projectIds.length,
  };
  logger.info(
    { totalMs: stats.totalMs, vector: stats.vectorCount, keyword: stats.keywordCount, returned: stats.returned },
    'retrieval completed',
  );
  return { sources, stats };
}

module.exports = { retrieve, fuse, toSource, lexicalRerank, applyRelativeCutoff, toVectorLiteral, RRF_K };
