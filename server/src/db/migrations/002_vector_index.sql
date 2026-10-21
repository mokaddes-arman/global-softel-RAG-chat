-- =============================================================================
-- 002_vector_index.sql
-- Approximate-nearest-neighbour index for cosine similarity search.
--
-- Building an HNSW index is OPTIONAL and can fail on very small embedded
-- databases or when the pgvector build lacks HNSW support. We therefore wrap it
-- in an exception handler: if it cannot be created, retrieval still works
-- exactly (sequential scan), which is perfectly fine for a personal knowledge
-- base. A NOTICE is emitted instead of aborting the migration.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'idx_chunks_embedding_hnsw'
  ) THEN
    EXECUTE 'CREATE INDEX idx_chunks_embedding_hnsw ON document_chunks '
         || 'USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)';
    RAISE NOTICE 'Created HNSW vector index.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Skipping HNSW vector index (%). Exact search will be used.', SQLERRM;
END;
$$;
