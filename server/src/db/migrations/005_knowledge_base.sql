-- =============================================================================
-- 005_knowledge_base.sql - web links, link lists, collections and crawl jobs
--
-- Extends the knowledge base beyond uploaded files:
--
--   link_lists      a named batch of URLs ("the API reference set")
--   link_list_items the URLs that belong to a list
--   web_links       a single URL that belongs to the knowledge base
--   collections     a named group of documents and web links
--   collection_items the members of a collection
--   crawl_jobs      the queue that fetches a web link and indexes it
--
-- A crawled page becomes a normal `documents` row (a .md version), so it is
-- retrieved, cited and versioned exactly like an uploaded file.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- link_lists : a named, reusable batch of URLs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS link_lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_link_lists_project ON link_lists (project_id, updated_at DESC);
DROP TRIGGER IF EXISTS trg_link_lists_updated_at ON link_lists;
CREATE TRIGGER trg_link_lists_updated_at BEFORE UPDATE ON link_lists
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- link_list_items : the URLs of a list (one per line when pasted by a human)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS link_list_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_list_id uuid NOT NULL REFERENCES link_lists(id) ON DELETE CASCADE,
  url          text NOT NULL,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_link_list_items_list ON link_list_items (link_list_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS uq_link_list_items_url ON link_list_items (link_list_id, url);

-- ---------------------------------------------------------------------------
-- collections : named groups of knowledge-base items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collections_project ON collections (project_id, updated_at DESC);
DROP TRIGGER IF EXISTS trg_collections_updated_at ON collections;
CREATE TRIGGER trg_collections_updated_at BEFORE UPDATE ON collections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- web_links : a URL that belongs to the knowledge base
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS web_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url             text NOT NULL,
  canonical_url   text NOT NULL,
  title           text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','crawling','indexed','failed','archived')),
  collection_id   uuid REFERENCES collections(id) ON DELETE SET NULL,
  link_list_id    uuid REFERENCES link_lists(id) ON DELETE SET NULL,
  document_id     uuid REFERENCES documents(id) ON DELETE SET NULL,
  content_hash    text,
  crawl_count     integer NOT NULL DEFAULT 0,
  last_crawled_at timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_web_links_project ON web_links (project_id, status);
CREATE INDEX IF NOT EXISTS idx_web_links_collection ON web_links (collection_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_web_links_project_url ON web_links (project_id, canonical_url);
DROP TRIGGER IF EXISTS trg_web_links_updated_at ON web_links;
CREATE TRIGGER trg_web_links_updated_at BEFORE UPDATE ON web_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- collection_items : the members of a collection (a document OR a web link)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collection_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  document_id   uuid REFERENCES documents(id) ON DELETE CASCADE,
  web_link_id   uuid REFERENCES web_links(id) ON DELETE CASCADE,
  added_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((document_id IS NOT NULL) <> (web_link_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_collection_items_collection ON collection_items (collection_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_items_document
  ON collection_items (collection_id, document_id) WHERE document_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_items_link
  ON collection_items (collection_id, web_link_id) WHERE web_link_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- crawl_jobs : the queue that fetches a web link and indexes it
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crawl_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  web_link_id  uuid NOT NULL REFERENCES web_links(id) ON DELETE CASCADE,
  job_type     text NOT NULL DEFAULT 'crawl' CHECK (job_type IN ('crawl','recrawl')),
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','processing','completed','failed','cancelled')),
  stage        text NOT NULL DEFAULT 'queued',
  progress     integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  error        text,
  error_code   text,
  metrics      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crawl_jobs_status ON crawl_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_crawl_jobs_link ON crawl_jobs (web_link_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crawl_jobs_project ON crawl_jobs (project_id, created_at DESC);
DROP TRIGGER IF EXISTS trg_crawl_jobs_updated_at ON crawl_jobs;
CREATE TRIGGER trg_crawl_jobs_updated_at BEFORE UPDATE ON crawl_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
