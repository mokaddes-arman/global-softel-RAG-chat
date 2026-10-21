-- =============================================================================
-- 001_init.sql - core schema for Global Softel RAG Chat
--
-- Runs unchanged on a real PostgreSQL server (>= 14 + pgvector) and on the
-- embedded PGlite build (real Postgres compiled to WASM + real pgvector).
-- The placeholder {{EMBEDDING_DIM}} is substituted at migration time from the
-- EMBEDDING_DIM environment variable.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Updated-at bookkeeping
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- application_settings : simple single-user key/value configuration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- projects : independent knowledge bases
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  description text,
  status      text NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'archived')),
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);
DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- embedding_configs : which embedding model/endpoint is usable
-- (keys encrypted, never plaintext)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS embedding_configs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  provider      text NOT NULL,                       -- local | ollama | openai
  model         text NOT NULL,
  dimension     integer NOT NULL CHECK (dimension > 0),
  base_url      text,
  key_enc       text,
  key_iv        text,
  key_tag       text,
  key_hint      text,
  extra         jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled       boolean NOT NULL DEFAULT true,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, model, dimension)
);
DROP TRIGGER IF EXISTS trg_embedding_configs_updated_at ON embedding_configs;
CREATE TRIGGER trg_embedding_configs_updated_at BEFORE UPDATE ON embedding_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- embedding_models : registry of every embedding space that has ever been used.
-- Chunks reference the model that produced their vector so incompatible
-- embeddings can never be silently mixed in one search space.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS embedding_models (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  model         text NOT NULL,
  dimension     integer NOT NULL CHECK (dimension > 0),
  config_id     uuid REFERENCES embedding_configs(id) ON DELETE SET NULL,
  is_active     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, model, dimension)
);

-- ---------------------------------------------------------------------------
-- llm_provider_configs : hosted / OpenAI-compatible chat providers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS llm_provider_configs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  provider          text NOT NULL,                    -- openrouter | groq (mock in tests only)
  model             text NOT NULL,
  base_url          text,
  key_enc           text,
  key_iv            text,
  key_tag           text,
  key_hint          text,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled           boolean NOT NULL DEFAULT true,
  is_default_chat   boolean NOT NULL DEFAULT false,
  last_tested_at    timestamptz,
  last_test_ok      boolean,
  last_test_error   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_llm_configs_default ON llm_provider_configs (is_default_chat, enabled);
DROP TRIGGER IF EXISTS trg_llm_configs_updated_at ON llm_provider_configs;
CREATE TRIGGER trg_llm_configs_updated_at BEFORE UPDATE ON llm_provider_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- documents : a logical document inside a project (may have many versions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title             text NOT NULL,
  original_filename text NOT NULL,
  file_ext          text NOT NULL,
  mime_type         text,
  size_bytes        bigint NOT NULL DEFAULT 0,
  sha256            text NOT NULL,
  storage_path      text NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','indexed','failed','archived')),
  archived          boolean NOT NULL DEFAULT false,
  current_version_id uuid,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents (project_id, archived, status);
CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents (project_id, sha256);
DROP TRIGGER IF EXISTS trg_documents_updated_at ON documents;
CREATE TRIGGER trg_documents_updated_at BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- document_versions : immutable history of a document
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_number    integer NOT NULL CHECK (version_number > 0),
  original_filename text NOT NULL,
  file_ext          text NOT NULL,
  mime_type         text,
  size_bytes        bigint NOT NULL DEFAULT 0,
  sha256            text NOT NULL,
  storage_path      text NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','indexed','failed','superseded')),
  is_active         boolean NOT NULL DEFAULT false,
  parser            text,
  chunk_count       integer NOT NULL DEFAULT 0,
  page_count        integer,
  token_count       integer,
  source_metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  error             text,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  indexed_at        timestamptz,
  embedding_model_id uuid REFERENCES embedding_models(id) ON DELETE SET NULL,
  UNIQUE (document_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_versions_document ON document_versions (document_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_versions_project_status ON document_versions (project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_versions_active
  ON document_versions (document_id) WHERE is_active;

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS fk_documents_current_version;
ALTER TABLE documents
  ADD CONSTRAINT fk_documents_current_version
  FOREIGN KEY (current_version_id) REFERENCES document_versions(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- ingestion_jobs : database-backed work queue (no Redis required)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id         uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  job_type            text NOT NULL DEFAULT 'ingest' CHECK (job_type IN ('ingest','reindex')),
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','processing','completed','failed','cancelled')),
  stage               text NOT NULL DEFAULT 'queued',
  progress            integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 3,
  error               text,
  error_code          text,
  metrics             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON ingestion_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_version ON ingestion_jobs (document_version_id);
DROP TRIGGER IF EXISTS trg_jobs_updated_at ON ingestion_jobs;
CREATE TRIGGER trg_jobs_updated_at BEFORE UPDATE ON ingestion_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- document_chunks : the retrievable units + their vectors
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_chunks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id         uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  chunk_index         integer NOT NULL,
  content             text NOT NULL,
  token_count         integer NOT NULL DEFAULT 0,
  char_count          integer NOT NULL DEFAULT 0,
  embedding           vector({{EMBEDDING_DIM}}),
  embedding_model_id  uuid REFERENCES embedding_models(id) ON DELETE SET NULL,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  search              tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chunks_project ON document_chunks (project_id);
CREATE INDEX IF NOT EXISTS idx_chunks_version ON document_chunks (document_version_id);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_search ON document_chunks USING gin (search);
CREATE INDEX IF NOT EXISTS idx_chunks_model ON document_chunks (embedding_model_id);

-- ---------------------------------------------------------------------------
-- conversations / messages / sources
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        text NOT NULL DEFAULT 'New conversation',
  archived     boolean NOT NULL DEFAULT false,
  llm_config_id uuid REFERENCES llm_provider_configs(id) ON DELETE SET NULL,
  provider     text,
  model        text,
  retrieval_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations (project_id, archived, updated_at DESC);
DROP TRIGGER IF EXISTS trg_conversations_updated_at ON conversations;
CREATE TRIGGER trg_conversations_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content         text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'complete' CHECK (status IN ('streaming','complete','error','aborted')),
  provider        text,
  model           text,
  token_usage     jsonb,
  latency_ms      integer,
  error_code      text,
  error_message   text,
  retrieval_meta  jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS message_sources (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id          uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chunk_id            uuid REFERENCES document_chunks(id) ON DELETE SET NULL,
  document_id         uuid REFERENCES documents(id) ON DELETE SET NULL,
  document_version_id uuid REFERENCES document_versions(id) ON DELETE SET NULL,
  rank                integer NOT NULL DEFAULT 0,
  score               double precision NOT NULL DEFAULT 0,
  vector_rank         integer,
  keyword_rank        integer,
  rerank_score        double precision,
  citation_label      text,
  source_location     text,
  document_title      text,
  document_version_number integer,
  excerpt             text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sources_message ON message_sources (message_id, rank);
