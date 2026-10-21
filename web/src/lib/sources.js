// Normalises the two source shapes the app encounters:
//  - live streamed results (camelCase, from retrieval.toSource)
//  - persisted citations (snake_case, from the message_sources table)
// so views can render them uniformly.

export function describeLocation(meta) {
  if (!meta || typeof meta !== 'object') return 'location not available';
  const parts = [];
  if (meta.page !== undefined && meta.page !== null) parts.push(`page ${meta.page}`);
  if (meta.sheet) parts.push(`worksheet "${meta.sheet}"`);
  if (meta.slide !== undefined && meta.slide !== null) parts.push(`slide ${meta.slide}`);
  if (meta.section) parts.push(`section "${meta.section}"`);
  if (meta.rowRange) parts.push(`rows ${meta.rowRange[0]}-${meta.rowRange[1]}`);
  if (!parts.length && meta.label) parts.push(meta.label);
  return parts.length ? parts.join(', ') : 'location not available';
}

export function normaliseSource(source) {
  if (!source) return null;
  const location = source.location || {};
  return {
    id: source.id || source.chunkId || source.chunk_id,
    chunkId: source.chunkId || source.chunk_id || null,
    documentId: source.documentId || source.document_id || null,
    documentVersionId: source.documentVersionId || source.document_version_id || null,
    documentTitle: source.documentTitle || source.document_title || 'Untitled document',
    documentVersionNumber:
      source.documentVersionNumber ?? source.document_version_number ?? null,
    rank: source.rank ?? null,
    score: source.score ?? null,
    vectorScore: source.vectorScore ?? source.vector_score ?? null,
    keywordScore: source.keywordScore ?? source.keyword_score ?? null,
    vectorRank: source.vectorRank ?? source.vector_rank ?? null,
    keywordRank: source.keywordRank ?? source.keyword_rank ?? null,
    rerankScore: source.rerankScore ?? source.rerank_score ?? null,
    location,
    sourceLocation:
      source.sourceLocation || source.source_location || describeLocation(location),
    excerpt: source.excerpt || '',
    fileExt: source.fileExt || source.file_ext || null,
    isActiveVersion: source.isActiveVersion ?? source.is_active ?? null,
  };
}

export function groupSourcesByMessage(sources = []) {
  const map = new Map();
  for (const raw of sources) {
    const messageId = raw.messageId || raw.message_id;
    if (!messageId) continue;
    if (!map.has(messageId)) map.set(messageId, []);
    map.get(messageId).push(normaliseSource(raw));
  }
  for (const list of map.values()) list.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return map;
}
