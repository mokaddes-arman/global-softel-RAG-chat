# Global Softel RAG Chat

A **locally hosted, project-scoped Retrieval-Augmented Generation assistant** for teams
that need grounded answers over their own engineering documentation — with **verifiable
citations** and **strict per-project isolation**.

- Answers are produced **only** from retrieved document excerpts. If the evidence is not
  there, the assistant **abstains** instead of guessing.
- Every citation points at a **real stored chunk** (document + version + location) that you
  can open and inspect.
- Projects are isolated by default. Cross-project retrieval happens **only** when you
  explicitly ask for it.
- Provider API keys are **encrypted at rest** (AES-256-GCM) and never stored, returned, or
  logged in plaintext.
- Everything runs on your machine. Documents, vectors and history stay local.

---

## Contents

1. [Requirements](#requirements)
2. [Quick start (PowerShell)](#quick-start-powershell)
3. [How it runs](#how-it-runs)
4. [Configuration](#configuration)
5. [Commands](#commands)
6. [Testing & verification](#testing--verification)
7. [API surface](#api-surface)
8. [Security model](#security-model)
9. [Project layout](#project-layout)
10. [Known limitations](#known-limitations)

---

## Requirements

| Requirement | Notes |
| --- | --- |
| **Node.js >= 20.11** | Verified on Node **24.21.0** / npm **11.19.0**. |
| **npm** | Comes with Node. |
| **PostgreSQL + pgvector** | **Optional.** Not required for the default setup — see below. |
| **git / psql / ollama** | **Optional.** None are required by the app. |

### Database: zero-install by default

The app ships an **embedded PostgreSQL (PGlite) with the real `pgvector` extension**.
When `DATABASE_URL` is empty it stores everything under `storage/pgdata` — **no PostgreSQL
server, no `psql`, no Docker**. To use a real PostgreSQL instead, set `DATABASE_URL` and the
app switches over automatically (see [Configuration](#configuration)).

> `psql` and `ollama` are **not** on `PATH` on this machine; the app was fully installed,
> booted and tested without them. `git` is used only to publish the source.

---

## Quick start (PowerShell)

```powershell
# 1. Install dependencies (workspaces: server + web)
npm install

# 2. Create your environment file and set a master key
Copy-Item .env.example .env
node -e "console.log('APP_MASTER_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
#   -> paste that line into .env (replace the placeholder)

# 3. Pre-flight check (Node/npm/.env/master key/storage)
npm run setup

# 4. Create the schema (embedded PGlite — no server needed; also runs on boot)
npm run db:migrate

# 5. Developer mode: API on :3001 + Vite UI on :5173
npm run dev
#   open http://localhost:5173
```

The backend dev script intentionally runs **without file-watching**. PGlite is a single
process, and restarting it while it is writing can abort/corrupt the embedded database.
The UI still hot-reloads; after changing backend files, stop the stack with `Ctrl+C` and
run `npm run dev` again. Do not run two dev stacks at once — the second API will fail with
“database already open”. Use a real PostgreSQL (`DATABASE_URL`) if you want file-watching.

**Production-style single origin** (the backend serves the built SPA, one port):

```powershell
npm run build      # builds web/dist
npm start          # serves UI + API on http://127.0.0.1:3001
```

Then in the UI: **create a project → upload documents → wait for "indexed" → ask a question
→ read the grounded answer and expand its citations.**

To get *generated* answers you must add an LLM provider key in **Settings** (stored
encrypted). With no key configured, retrieval, document management and citation inspection
still work, but no answer is generated.

---

## How it runs

```
Browser (React + Vite + Tailwind)
   │  /api  (same origin in production; Vite dev proxy in development)
   ▼
Express API (CommonJS) ── Zod validation, narrow CORS, security headers
   │
   ├── Ingestion worker (DB-backed job queue)
   │     parsers → structure-aware chunker → embeddings → document_chunks
   │
   ├── Crawl worker (DB-backed job queue)
   │     SSRF-safe fetch → HTML→Markdown → document version → ingestion
   │
   ├── Retrieval (hybrid)
   │     pgvector cosine search  +  PostgreSQL full-text search
   │     → Reciprocal Rank Fusion → optional rerank → relative-score cutoff
   │
   ├── Grounding prompt (evidence wrapped as untrusted data)
   │
   └── LLM provider registry (OpenRouter / Groq - OpenAI-compatible)
         streaming via Server-Sent Events

Storage: local filesystem (originals + artefacts)
Database: PostgreSQL + pgvector  (or embedded PGlite + pgvector)
```

- **Embeddings:** local by default via `@xenova/transformers` (`all-MiniLM-L6-v2`, 384 dims).
  `ollama`, an OpenAI-compatible endpoint, and a deterministic offline `hash` provider are
  also available. Dimension is stored in the DB and validated.
- **Document versioning:** re-uploading the same content is detected by hash. History is
  immutable; a version is explicitly activated, and it can be searched only on request
  (`includeHistoricalVersions`).
- **Multi-format ingestion:** PDF, DOCX, XLSX, PPTX, TXT, Markdown, CSV, JSON, YAML,
  HTML, XML, RTF, ODT/ODS/ODP, source code and logs (~49 extensions).
- **Per-project persona:** each project can carry operator **instructions** that give the
  assistant a role (e.g. *Senior SQA Engineer*) and an output convention. They are appended
  to the grounded prompt and stay **subordinate** to the grounding/citation/untrusted-content
  rules, so they can never make the assistant invent facts or leak secrets. Editable in
  *Dashboard → Edit* (with a starter persona template and an 8000-character limit).
- **Knowledge base:** besides files, a project can hold **web links** (pages that are crawled
  into documents), **link lists** (a named set of URLs to import in one go) and
  **collections** (named groups of documents and links). See below.

### The Documents page: "Upload documents" and "View documents"

The **Documents** entry in the sidebar has two sections:

| Section | What it holds |
| --- | --- |
| **Upload documents** | Everything that *adds* to the knowledge base: the file drop zone, **web links**, **link lists**, **collections** and the **crawl jobs** that fetch the linked pages. |
| **View documents** | The document table (search, status filter, archived toggle, versions, re-index) plus the shared **`.md`** file of every document. |

**Web links** are pages on the internet that become part of the knowledge base. Paste one or
more URLs and they are queued for a crawl: the page is fetched, converted to Markdown and
stored as a normal document version, so it is retrieved, cited and versioned exactly like an
uploaded file. **Re-crawl** fetches the page again and adds a **new version** — the previous
content stays available, which is what keeps old citations verifiable.

**Link lists** are named sets of URLs. A list is inert until it is **imported**, which turns
every URL into a web link and queues a crawl for each of them (optionally into a collection).

**Collections** group documents and web links under a name. A collection is a view over the
knowledge base, not a copy: the items keep their own versions and crawl history.

**Crawl jobs** record every fetch. A failed job can be retried, which puts the link back into
the queue.

**Sharing a document as Markdown.** Every document can be handed out as a single `.md` file —
the content of the active version with a small YAML front-matter header (title, source,
project, version, and the source URL for a crawled page). In **View documents** each row has a
**View .md** button (renders the file in the app, with a *Source* tab for the raw bytes) and a
**download icon** that saves it as `<title>.md`.

### Crawling is SSRF-safe

A crawler fetches URLs a human typed in, so it is a classic server-side request forgery
vector. The fetcher therefore:

- accepts only `http`/`https` and refuses URLs with embedded credentials;
- refuses hostnames that resolve to a **loopback, link-local, private or unique-local**
  address (so `http://169.254.169.254/` — the cloud metadata endpoint — is never read);
- **re-validates every redirect hop**;
- caps the response size and the request duration.

Set `CRAWL_ALLOW_PRIVATE_HOSTS=true` only on a trusted machine (it is enabled automatically
for the test suite so it can crawl a local fixture server).

### Per-project persona & HTML deliverables

Set the instructions on a project (Dashboard → Edit → *Instructions / persona*) to steer the
assistant's role and output style for that project only. A common setup is the built-in
**Senior SQA Engineer** persona, which asks the model to produce QA deliverables — test plans,
requirement/traceability mappings, test cases, test reports, bug reports, feature listings —
as **self-contained HTML**.

When an answer contains a fenced ` ```html ` block, the chat renders it as an **HTML
deliverable**: the raw markup is shown in a code view, and a **Preview / Copy / Download**
button lets you inspect or save it. The preview is always **sandboxed in a blank iframe**
(`sandbox=""` — no scripts, no same-origin, no forms), so model-authored HTML can never run
against the app or read your data. The model authors the HTML itself; nothing is templated in
code beyond the optional starter persona.

Grounding and abstention are unchanged by any persona: the model is still only invoked when
evidence exists, and every claim is still tied to a real, cited source.

### Providers & the model-usage page

**Exactly two providers can answer questions.**

| Provider | Endpoint | Default model |
| --- | --- | --- |
| **OpenRouter** (primary) | `https://openrouter.ai/api/v1` | `nvidia/nemotron-3-ultra-550b-a55b:free` |
| **Groq** (fallback) | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` |

Both speak the OpenAI chat-completions protocol, so they share one adapter. Configure them in
**Settings → AI Providers** (the key is encrypted at rest), or for a UI-free setup with the
optional `OPENROUTER_API_KEY` / `GROQ_API_KEY` variables in `.env` (see `.env.example`).
Precedence is: the provider configured in Settings first, then the environment values.

**Automatic fallback and model rotation.** If OpenRouter has no key, or the request fails
with a rate limit / quota error, the app retries the same question once through **Groq**
and records which provider actually answered (`messages.provider`, `messages.model`).

Provider catalogues change — a model that worked yesterday can be retired overnight
(OpenRouter dropped `deepseek/deepseek-chat-v3-0324:free`, Groq dropped
`llama-3.1-8b-instant`). Each provider therefore keeps an ordered list of known models, and
a request that fails with `model_not_found` is retried with the next known model of the
same provider before the provider fallback is used. A timeout is never retried.

A third, **offline `mock`** adapter exists so the automated test suite and the end-to-end
run need no API key and no network. It is registered **only** when the process starts with
`NODE_ENV=test` (or under Vitest), so it can never answer a real question in a normal run.

**Model usage page (`/model-usage`).** Usage is measured from this app's own completed
answers. The page lists every model used with its requests and input/output/total tokens,
an average per request, and a grand total. Filter by day, week, month, year, or a custom
calendar range, and group the time-series chart by day/week/month/year.

---

## Configuration

All configuration lives in `.env` (never committed). `.env.example` documents every value.
The most important ones:

| Variable | Purpose | Default |
| --- | --- | --- |
| `HOST` / `PORT` | Bind address / port (localhost by default). | `127.0.0.1` / `3001` |
| `DATABASE_URL` | Real PostgreSQL + pgvector. **Empty → embedded PGlite.** | *(empty)* |
| `PGLITE_DIR` | Embedded database directory. | `./storage/pgdata` |
| `APP_MASTER_KEY` | 32+ char key that encrypts provider keys at rest. | *(must set)* |
| `STORAGE_DIR` | Uploaded files and artefacts. | `./storage` |
| `DEFAULT_EMBEDDING_PROVIDER` | `local` \| `ollama` \| `openai` \| `hash`. | `local` |
| `DEFAULT_EMBEDDING_MODEL` | Model id (must match `EMBEDDING_DIM`). | `Xenova/all-MiniLM-L6-v2` |
| `EMBEDDING_DIM` | Stored vector dimension. | `384` |
| `DISABLE_HOSTED_AI` | Privacy mode: refuse all hosted LLM calls. | `false` |
| `DEFAULT_LLM_PROVIDER` | Provider that answers questions — `openrouter` \| `groq`. | `openrouter` |
| `DEFAULT_LLM_MODEL` | Default model id for the chosen provider. | `nvidia/nemotron-3-ultra-550b-a55b:free` |
| `OPENROUTER_API_KEY` | *(optional)* env fallback for the OpenRouter key. | *(empty)* |
| `GROQ_API_KEY` | *(optional)* env fallback for the Groq key. | *(empty)* |
| `RETRIEVAL_TOP_K` | Number of chunks returned. | `8` |
| `CRAWL_ALLOW_PRIVATE_HOSTS` | Allow the crawler to fetch loopback/private hosts (SSRF guard). | `false` |

### Web crawling

The knowledge base can ingest **web pages**. The crawler is deliberately conservative:

| Variable | Purpose | Default |
| --- | --- | --- |
| `CRAWL_TIMEOUT_MS` | Maximum duration of one page fetch. | `30000` |
| `CRAWL_MAX_BYTES` | Hard cap on one downloaded page. | `5242880` (5 MiB) |
| `CRAWL_MAX_REDIRECTS` | Redirect hops allowed (each hop is re-validated). | `5` |
| `CRAWL_MAX_ATTEMPTS` | Attempts per crawl job before it is marked failed. | `3` |
| `CRAWL_CONCURRENCY` | Pages fetched in parallel by the crawl worker. | `1` |
| `CRAWL_USER_AGENT` | `User-Agent` sent with every fetch. | `GlobalSoftelRagBot/1.0 …` |
| `CRAWL_ALLOW_PRIVATE_HOSTS` | Allow loopback/private/link-local targets. **Off by default** (SSRF protection). | `false` |
| `CRAWL_STALE_JOB_MS` | A "processing" crawl job older than this is orphaned and re-queued. | `300000` |

### Deadlines (nothing can hang)

Every stage of a question and of an ingestion run has its own budget, so the UI always
gets a definite answer instead of an endless spinner.

| Variable | Guards | Default |
| --- | --- | --- |
| `ASK_TIMEOUT_MS` | The whole ask (provider → retrieval → generation). | `180000` |
| `RETRIEVAL_TIMEOUT_MS` | Embedding + hybrid search for one question. | `60000` |
| `DB_QUERY_TIMEOUT_MS` | Any single SQL statement. | `30000` |
| `LLM_REQUEST_TIMEOUT_MS` | The provider HTTP request. | `120000` |
| `LLM_STREAM_IDLE_TIMEOUT_MS` | Maximum silence between two streamed tokens. | `60000` |
| `EMBEDDING_REQUEST_TIMEOUT_MS` | The embedding provider request. | `60000` |
| `INGESTION_PARSE_TIMEOUT_MS` | Parsing one document. | `180000` |
| `INGESTION_JOB_TIMEOUT_MS` | One ingestion job, end to end. | `900000` |
| `INGESTION_STALE_JOB_MS` | A "processing" job older than this is orphaned and re-queued. Keep it **above** `INGESTION_JOB_TIMEOUT_MS`. | `1200000` |
| `CRAWL_TIMEOUT_MS` | One page fetch (web crawl). | `30000` |
| `CRAWL_STALE_JOB_MS` | A "processing" crawl job older than this is orphaned and re-queued. | `300000` |

Generate a master key:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Using a real PostgreSQL instead of PGlite

```powershell
# 1. Create a database and enable pgvector once:
#    CREATE EXTENSION IF NOT EXISTS vector;
# 2. Point the app at it in .env:
#    DATABASE_URL=postgres://rag_user:change_me@localhost:5432/rag_chat
# 3. Apply migrations:
npm run db:migrate
```

---

## Commands

Run from the repository root:

| Command | What it does |
| --- | --- |
| `npm install` | Install all workspaces. |
| `npm run setup` | Pre-flight check: Node/npm, `.env`, master key, storage, optional tools. |
| `npm run dev` | API (`:3001`) + Vite UI (`:5173`) together. |
| `npm run dev:server` / `npm run dev:web` | Run just one side. The server does not file-watch; restart it after backend edits. |
| `npm run build` | Build the React SPA into `web/dist`. |
| `npm start` | Serve API **and** built SPA from one origin (`:3001`). |
| `npm run db:migrate` / `npm run db:status` | Apply / inspect migrations. |
| `npm run check` | Backend readiness report (DB, pgvector, schema, embeddings, providers). |
| `npm test` | Backend unit + integration tests (Vitest). |
| `npm run test:e2e` | Playwright end-to-end suite (builds the SPA and boots its own server). |
| `npm run eval:rag` | Offline retrieval evaluation dataset + grounded-answer smoke test. |

---

## Testing & verification

Current status on this machine (all commands run from the repo root):

| Suite | Command | Result |
| --- | --- | --- |
| Backend unit + integration | `npm test` | **128 passed** (14 files) |
| End-to-end (real browser + real backend) | `npm run test:e2e` | **17 passed** |
| Retrieval evaluation | `npm run eval:rag` | **8/8 retrieval (100%) + e2e smoke pass** |
| Backend readiness | `npm run check` | **all checks passed** |

**What each suite proves**

- **Backend tests** — parsers, chunker, encryption, security (path traversal, validation,
  CORS), projects, documents/versioning, providers, retrieval, and the chat contract
  (grounding, abstention, source persistence, SSE streaming, prompt-injection wrapping).
  The knowledge base has its own coverage: URL parsing/canonicalisation, private-host
  refusal, link lists, collections, crawl jobs and the `.md` export.
- **End-to-end tests** — a real Chromium browser drives the actual SPA against a real
  backend: onboarding → project → document upload → indexing → ask → read the grounded
  answer and expand its citations; the HTTP-level RAG contract (retrieval, grounding,
  abstention on empty projects, per-project isolation and explicit cross-project opt-in);
  and the knowledge-base flow (crawl a page → it becomes a document → preview and download
  its `.md`, create a link list and a collection).
- **RAG evaluation** — ingests a small labelled corpus and checks the right chunks are
  retrieved, that clearly-absent facts are **not** surfaced, and that a question yields a
  grounded answer with citations.

The e2e suite is deliberately **offline and deterministic**: it uses the embedded PGlite
database in a throwaway `storage/.e2e`, the `hash` embedding provider and the `mock` LLM
provider, so it needs no API keys and no network. It validates **wiring, grounding and
citations** — not model answer quality. Validate answer quality with your own model via
`npm run eval:rag` after configuring providers in Settings.

---

## API surface

All routes are under `/api`. Highlights:

| Area | Endpoints |
| --- | --- |
| Health | `GET /health`, `GET /health/ready`, `GET /system/status` |
| Projects | `GET/POST /projects`, `GET/PATCH/DELETE /projects/:id` |
| Documents | `POST /projects/:projectId/documents/upload`, `GET /projects/:id/documents`, `GET/DELETE /documents/:id`, `GET /documents/:id/versions`, `POST /documents/:id/activate-version`, `POST /documents/:id/reindex`, `POST /documents/:id/restore`, `GET /documents/:id/file`, `GET /chunks/:id` |
| Markdown export | `GET /documents/:id/markdown` (JSON preview), `GET /documents/:id/markdown/download` (raw `.md` attachment; optional `?versionId=`) |
| Web links | `GET/POST /projects/:id/links`, `GET/PATCH/DELETE /links/:id`, `POST /links/:id/crawl` (re-crawl → new version) |
| Link lists | `GET/POST /projects/:id/link-lists`, `GET/DELETE /link-lists/:id`, `POST /link-lists/:id/items`, `POST /link-lists/:id/import` |
| Collections | `GET/POST /projects/:id/collections`, `GET/PATCH/DELETE /collections/:id`, `POST /collections/:id/items`, `DELETE /collections/:id/items/:itemId` |
| Crawl jobs | `GET /projects/:id/crawl-jobs`, `POST /crawl-jobs/:id/retry` |
| Conversations | `POST /projects/:projectId/conversations`, `GET /projects/:id/conversations`, `GET/PATCH/DELETE /conversations/:id`, `GET /conversations/:id/messages` |
| Answering | `POST /conversations/:id/messages` (SSE stream or JSON), `POST /conversations/:id/evidence` (retrieval only) |
| Projects (extra) | `GET /projects/:id/stats`, `GET /projects/:id/search`, `POST /projects/:id/archive` and `/restore`, `GET /projects/:id/jobs`, `POST /jobs/:id/retry` |
| Providers | `GET /providers/metadata`, `GET/POST /providers/llm`, `GET/PATCH/DELETE /providers/llm/:id`, `POST /providers/llm/test` (and `/:id/test`), `POST /providers/llm/:id/default`; the same shape for `/providers/embedding` |
| Usage | `GET /model-usage` (per-model token usage; `from`, `to`, `granularity`, `provider`, `model`, `projectId`), `GET /model-usage/catalog` (the configured OpenRouter/Groq models) |
| Settings | `GET/PUT /settings`, `GET /settings/:key`, `GET /settings/embedding-index` |

Streaming answers emit Server-Sent Events: `status`, `retrieval`, `sources`, `token`,
`done`, `complete`, `error`.

---

## Security model

- **Localhost only by default** (`HOST=127.0.0.1`); narrow CORS allow-list; strict security
  headers; no `x-powered-by`.
- **Every request body/query/param is validated with Zod**; SQL is fully parameterised.
- **Uploads** are stored with sanitised names; path traversal is rejected; size limits apply.
- **API keys** are encrypted with AES-256-GCM using a key derived from `APP_MASTER_KEY`,
  returned only masked, and never logged.
- **Prompt injection:** retrieved text is wrapped in explicit evidence blocks and the system
  prompt instructs the model to treat it as untrusted data and never to reveal secrets or
  follow embedded instructions.
- `DISABLE_HOSTED_AI=true` blocks all outbound LLM calls for air-gapped operation.

---

## Project layout

```
.
├─ server/                 Express API (CommonJS)
│  ├─ src/
│  │  ├─ config/           validated .env
│  │  ├─ db/               PostgreSQL/PGlite layer, migrations, schema
│  │  ├─ crawl/            SSRF-safe fetcher, HTML→Markdown, crawl job worker
│  │  ├─ embeddings/       local / ollama / openai / hash providers
│  │  ├─ llm/              provider registry, prompt, streaming
│  │  ├─ ingestion/        job queue, worker, parsers, chunker
│  │  ├─ retrieval/        hybrid pgvector + full-text search, RRF, rerank
│  │  ├─ services/         projects, documents, conversations, providers, knowledge
│  │  ├─ middleware/       validation, errors, request context
│  │  └─ routes/           HTTP endpoints
│  ├─ tests/               Vitest unit + integration
│  ├─ eval/                retrieval evaluation corpus + dataset
│  └─ scripts/             check.mjs, rag-eval.mjs
├─ web/                    React + Vite + Tailwind SPA
│  └─ src/                 views, components, API client, theme
├─ e2e/                    Playwright specs + harness
├─ scripts/                check-prereqs.mjs
├─ storage/                runtime data (git-ignored)
├─ .env.example            configuration template
├─ playwright.config.js    e2e configuration (one origin, port 3101)
└─ TODO.md                 implementation checklist
```

---

## Known limitations

These are real and worth knowing before you rely on the app:

1. **Generated answers require a configured LLM provider.** Without a key in Settings, the
   app retrieves evidence and shows citations but does not produce an answer. Set an API
   key, or use the `mock`/local provider for testing.
2. **The default local embedding model downloads on first use.** `Xenova/all-MiniLM-L6-v2`
   (~90 MB) is fetched into `storage/models` the first time you index a document and needs
   network access. For a fully offline run, set `DEFAULT_EMBEDDING_PROVIDER=hash` — but note
   `hash` embeddings are **deterministic and not semantic**, suitable for development only.
3. **The embedded PGlite database is single-process.** An exclusive lock
   (`storage/pgdata.lock`) makes a second server, `npm run check`, migration or test run
   fail with a clear “already open” message instead of writing to the same directory.
   For that reason the backend dev script runs without `--watch`: restart it with
   `Ctrl+C` + `npm run dev` after backend edits, and never run two dev stacks. Use a real
   PostgreSQL (`DATABASE_URL`) if you need concurrency or file-watching. If startup still
   aborts with `Aborted()`, the data directory itself is corrupt: stop every server, move
   `storage/pgdata` aside, then run `npm run db:migrate` to create a fresh database.
   Uploaded source files remain under `storage/uploads`.
4. **E2E tests exercise the `mock` LLM and `hash` embeddings**, so they verify behaviour and
   citation integrity, not answer quality. Answer quality must be judged with a real model.
5. **The retrieval eval ships with an offline hash-embedding run.** It is a wiring/grounding
   regression check over a tiny corpus, not a benchmark of your production model.
6. **The working tree was not under version control until now.** The folder had no git
   repository, so early changes lived uncommitted on disk. It is now a git repository on the
   `global-softel` branch.
7. **Scanned PDFs (image-only) are not OCR'd.** If a PDF has almost no selectable text the
   parser records an `ocrLikely` warning and the document is ingested with little or no
   searchable content. See [Scanned PDFs](#scanned-pdfs) below.
8. **Reranking is off by default** (`RETRIEVAL_RERANK_ENABLED=false`) and the shipped rerank
   is a lightweight heuristic, not a cross-encoder.
9. **Only two providers can answer: OpenRouter and Groq.** There is no wider fallback chain.
   If OpenRouter fails *and* Groq is not configured (or also fails), the answer fails with an
   error message instead of a spinner — the assistant bubble always shows the outcome.
10. **Known model lists can go stale.** The app retries a retired model with the next known
    model of the same provider, but a provider can retire every model the app knows about.
    Use **Settings → AI Providers** to pick a model that the provider currently lists.
11. **Deadlines are fixed values, not adaptive.** A slow provider is cut off at
    `ASK_TIMEOUT_MS` / `LLM_REQUEST_TIMEOUT_MS` rather than being retried with a longer
    budget. Raise the values in `.env` if your provider is legitimately slow.
12. **Web crawling needs outbound network access** and is HTML-oriented. A linked PDF or
    other binary file is fetched but not parsed — crawl the page that links it, or upload
    the file directly. A crawled page is stored as Markdown, so heavy navigation chrome
    and styling are dropped.
13. **The crawler is deliberately slow.** `CRAWL_CONCURRENCY=1` by default so a crawl never
    hammers a third-party site; raise it only for pages you control.

### Scanned PDFs

Image-only ("scanned") PDFs have no extractable text, so the app cannot index them. When the
average extracted text is very low (below ~20 characters per page) the parser marks the
document with an `ocrLikely` warning rather than guessing at content. Run OCR on such files
before uploading. Password-protected or encrypted PDFs are rejected with a clear error.

---

*All figures above were produced by running the commands on this machine; no test results
are fabricated. See `TODO.md` for the implementation checklist.*
