# Global Softel RAG Chat — Limitations & Known Gaps

> A single, honest list of everything this app does **not** do well yet, so we can work
> through it one by one. Nothing here is hidden in code comments — if it can bite you, it is
> on this page.

**How to use this file**

- Every item has an **ID** (e.g. `A1`), a **severity**, and a short **"Work on it"** pointer
  to the file or area that owns it.
- Severities: **High** = blocks real use, or is a data/security risk · **Medium** = degrades
  quality or UX · **Low** = polish or convenience.
- Tick the box when the item is resolved. Keep this file as the source of truth.

**Snapshot (what exists today)**

- Backend: Node/Express (CommonJS), PostgreSQL + pgvector **or** embedded PGlite.
- Frontend: React + Vite + Tailwind.
- LLM providers that may answer questions: **OpenRouter** and **Groq** only.
- Verified green: 107 backend tests · 14 e2e tests · 8/8 RAG eval (all offline).

---

## A. Environment & setup

- [ ] **A1 — Optional tools are not installed (Low).** `psql` and `ollama` are not on
  `PATH` on this machine. The app does not need them, but you cannot use native PostgreSQL
  tooling or Ollama embeddings without installing them.
  *Work on it:* `npm run setup` reports status; install as needed.
- [x] **A2 — Version control (resolved).** The folder is now a git repository on the
  `global-softel` branch, with `.env`, `storage/`, uploads and the embedded database
  ignored.
- [ ] **A3 — Master key required to save providers (Medium).** If `APP_MASTER_KEY` is missing
  or left as the placeholder, saving an LLM/embedding provider fails because keys cannot be
  encrypted — and without a key you get no hosted answers.
  *Work on it:* set `APP_MASTER_KEY` in `.env` (boot logs a warning otherwise).
- [ ] **A4 — Local embedding model downloads on first use (Medium).** The first indexing run
  fetches `Xenova/all-MiniLM-L6-v2` (~90 MB) into `storage/models` and needs internet.
  *Work on it:* pre-download it, or use `DEFAULT_EMBEDDING_PROVIDER=hash` for offline (see C1).
- [ ] **A5 — Windows spawn notice (Low).** A `DEP0190` deprecation warning appears because npm
  is spawned with `shell: true` (required on Windows after a Node security change). Cosmetic.
  *Work on it:* `e2e/start-server.js`.
- [ ] **A6 — Node >= 20.11 required (Low).** Older Node is rejected by `npm run setup` and the
  `engines` field. *Work on it:* documented; not a defect.

## B. Data & storage

- [ ] **B1 — Embedded PGlite is single-process + WASM (Medium).** Only one server process may
  open `storage/pgdata`; performance and concurrency are below native PostgreSQL.
  *Work on it:* set `DATABASE_URL` to use real PostgreSQL.
- [ ] **B2 — No backup/restore tooling (Medium).** Nothing copies or restores the database or
  uploaded files. *Work on it:* back up `storage/` (or use `pg_dump` for PostgreSQL); add scripts.
- [ ] **B3 — Local filesystem only (Low).** No S3/object storage; uploads and artefacts live
  under `storage/`. *Work on it:* storage service under `server/src/services/`.
- [ ] **B4 — 50 MB upload cap by default (Low).** Controlled by `MAX_UPLOAD_SIZE_MB=50`.
  *Work on it:* raise it in `.env` if needed.
- [ ] **B5 — No retention/cleanup policy (Low).** Archived documents and finished jobs
  accumulate; nothing purges them. *Work on it:* add a maintenance script.

## C. Embeddings & retrieval

- [ ] **C1 — `hash` embeddings are not semantic (High for quality).** They are deterministic
  and intended for development/offline only; retrieval quality is weak. Used by the e2e suite
  and the shipped eval. *Work on it:* keep `local`/hosted embeddings for real use.
- [ ] **C2 — Embedding dimension is fixed at migration time (High).** `EMBEDDING_DIM` must match
  the model; switching to a model with a different dimension requires a migration **and**
  re-embedding every chunk. Stale chunks are only warned about, never migrated automatically.
  *Work on it:* `server/src/services/embeddings.js`, `server/src/db/migrations/`.
- [ ] **C3 — HNSW index is optional (Medium).** If it cannot be built, retrieval silently falls
  back to exact sequential search — correct, but slower on large corpora.
  *Work on it:* `server/src/db/migrations/002_vector_index.sql`.
- [ ] **C4 — Keyword search is English-only (Medium).** Full-text indexing uses
  `to_tsvector('english', content)`. Non-English documents lose stemming quality.
  *Work on it:* `001_init.sql`; make the text-search language configurable.
- [ ] **C5 — Reranking is a heuristic, and off by default (Medium).** It is "lexical coverage"
  (fraction of query terms present, rarity-weighted), **not** a cross-encoder.
  *Work on it:* `server/src/retrieval/hybrid.js`; add a real reranker adapter.
- [ ] **C6 — No query rewriting/expansion (Medium).** A single query is used; no HyDE,
  multi-query, or synonym expansion. *Work on it:* add a pre-retrieval step.
- [ ] **C7 — Top-K only (Low).** Returns `RETRIEVAL_TOP_K` chunks (default 8); there is no
  exhaustive matching. *Work on it:* tune in `.env` or settings.
- [ ] **C8 — Relative cutoff can drop relevant hits (Medium).** Vector-only matches scoring
  below 35% of the best hit are removed, which can hide a correct-but-lower-ranked chunk.
  *Work on it:* `RETRIEVAL_RELATIVE_CUTOFF` in `.env`.
- [ ] **C9 — Cross-project search is off by default (By design).** It must be explicitly
  requested per query to respect project isolation. *Work on it:* intended — keep.
- [ ] **C10 — Historical versions are not searched unless asked (By design).**
  `includeHistoricalVersions` must be set explicitly. *Work on it:* intended — keep.

## D. Answer generation

- [ ] **D1 — Generated answers need a hosted LLM key (High).** Without one you get retrieval and
  citations only — no prose answer is produced. *Work on it:* configure a provider in Settings.
- [x] **D2 — Cross-provider fallback (resolved).** If OpenRouter has no key, or its request
  fails with a rate limit / quota error, the same question is retried once through **Groq**
  and the provider that actually answered is recorded on the message. There is no chain
  beyond these two providers. *Owner:* `server/src/services/conversations.js`.
- [ ] **D3 — Single retrieval + single generation (Medium).** Not agentic: no tool use, no
  multi-step planning, no self-critique loop. *Work on it:* `ask()` in
  `server/src/services/conversations.js`.
- [ ] **D4 — Excerpts are truncated (Medium).** Each excerpt is capped (~1800 chars) and the
  total context is capped (`RETRIEVAL_MAX_CONTEXT_CHARS=16000`); very long passages are only
  partially represented. *Work on it:* config + prompt builder.
- [ ] **D5 — No conversation summarization (Medium).** Long chats send limited history; older
  turns may drop out of the model's context. *Work on it:* `buildConversationContext`.
- [ ] **D6 — Failed generation is not auto-retried (Low).** Ingestion jobs retry, but a failed
  answer simply returns an error. *Work on it:* add a retry path in `ask()`.
- [ ] **D7 — Streaming aborts on client disconnect (Low).** Closing the tab stops generation;
  the assistant message is then stored as `aborted` with the partial text. *Work on it:* SSE
  handler in `server/src/routes/conversations.js`.
- [ ] **D8 — `DISABLE_HOSTED_AI=true` blocks all generation (By design).** Privacy mode:
  retrieval and citations still work, answers do not. *Work on it:* intended — keep.
- [ ] **D9 — Conversation titles are heuristic (Low).** Derived from the first ~8 words; not
  model-generated, though a rename overrides it. *Work on it:* `deriveTitle`.
- [ ] **D10 — Deadlines are fixed, not adaptive (Medium).** A slow provider is cut off at
  `ASK_TIMEOUT_MS` (180 s) / `LLM_REQUEST_TIMEOUT_MS` (120 s) rather than retried with a
  longer budget. *Work on it:* raise the values in `.env`.
- [ ] **D11 — The mock provider is test-only (By design).** The offline `mock` adapter is
  registered only when `NODE_ENV=test` (or under Vitest), so it can never answer a real
  question. The e2e suite therefore validates wiring and citations, not prose quality.
  *Work on it:* intended — keep.
- [x] **D12 — Usage counts only completed answers (By design).** `/model-usage` aggregates
  `role='assistant'`, `status='complete'` messages with a recorded model; failed/aborted
  generations are excluded. *Work on it:* intended — keep.
- [ ] **D13 — No provider quota reporting (Low).** OpenRouter and Groq do not expose a
  remaining-allowance figure through this app, so `/model-usage` reports **usage**, not
  quota. *Work on it:* none — not exposed by the API.

## E. Ingestion & parsing

- [ ] **E1 — No OCR (High for scans).** Image-only/scanned PDFs have no selectable text, so they
  yield little searchable content and are only flagged, never read.
  *Work on it:* `server/src/ingestion/parsers/pdf.js` (add e.g. tesseract).
- [ ] **E2 — Complex layouts/tables lose structure (Medium).** PDF/DOCX tables and multi-column
  layouts are flattened to text; tables are not extracted as structured data.
  *Work on it:* `server/src/ingestion/parsers/`.
- [ ] **E3 — Text formats only (Medium).** No image, audio, or video understanding.
  *Work on it:* out of current scope; note if needed.
- [ ] **E4 — Format coverage is uneven (Medium).** ~49 extensions are supported, but real-world
  files vary a lot and some parsers are lightly exercised. *Work on it:* add per-format fixtures
  and tests.
- [ ] **E5 — Encrypted/password PDFs are rejected (By design).** A clear error is returned; there
  is no password prompt. *Work on it:* intended — keep.
- [ ] **E6 — Scan detection is a heuristic (Low).** The ~20 characters/page threshold can
  misjudge unusual PDFs (unusually sparse or dense). *Work on it:* threshold in `pdf.js`.

## F. Security & multi-user

- [ ] **F1 — No authentication/authorization (High if exposed).** The app is single-user and
  binds to localhost by default. Anyone who can reach the port can use it with full access.
  Do **not** set `HOST=0.0.0.0` without adding auth first.
  *Work on it:* `server/src/app.js` + new auth middleware.
- [ ] **F2 — No rate limiting on this API (Medium).** Only upstream provider 429s are handled;
  nothing throttles local requests. *Work on it:* add rate-limit middleware.
- [ ] **F3 — No audit log (Medium).** Uploads, deletes and provider edits are not recorded for
  later review. *Work on it:* add an events table.
- [ ] **F4 — Prompt-injection defence is best-effort (Medium).** Evidence is wrapped in explicit
  blocks and the prompt forbids following embedded instructions, but a model can still be
  influenced. *Work on it:* `server/src/llm/prompt.js`.
- [ ] **F5 — Keys are plaintext in memory during a call (Low).** Unavoidable when calling a
  provider. They are encrypted at rest and never logged or returned. *Work on it:* accept.
- [ ] **F6 — CORS allow-list defaults to dev origins (Low).** Fine for the Vite setup;
  production single-origin needs no CORS. *Work on it:* `CORS_ORIGIN` in `.env`.
- [ ] **F7 — No CSRF protection (Low).** No cookies/sessions are used, so classic CSRF does not
  apply — but there is also no auth to protect. *Work on it:* revisit together with F1.

## G. Product / UX scope

- [ ] **G1 — No internationalization (Low).** English UI and English keyword search.
  *Work on it:* add an i18n layer in `web/`.
- [ ] **G2 — Accessibility not formally audited (Medium).** Semantics and labels are in place,
  but no axe/Lighthouse pass has been run. *Work on it:* audit `web/`.
- [ ] **G3 — Basic mobile behaviour (Low).** Responsive layout with a slide-over sidebar, but not
  deeply tuned. *Work on it:* `web/src/`.
- [ ] **G4 — No API versioning or OpenAPI spec (Low).** Routes are unversioned and documented
  only by the README. *Work on it:* add `/api/v1` + a spec.
- [ ] **G5 — Logs only, no metrics (Low).** Observable through pino logs; no Prometheus/OTel.
  *Work on it:* add metrics.
- [ ] **G6 — No collaboration/multi-user (Medium).** No sharing, roles, or concurrent editing.
  *Work on it:* depends on F1.
- [ ] **G7 — No export of answers/citations (Low).** A conversation or report cannot be
  downloaded. *Work on it:* add an export endpoint/button.
- [ ] **G8 — No in-app feedback/eval loop (Low).** No thumbs up/down to capture which answers
  were good. *Work on it:* add a feedback table.
- [x] **G9 — Custom persona/instructions (resolved).** Each project now carries editable
  operator **instructions** (`projects.instructions`) that give the assistant a role (e.g.
  "senior SQA engineer") and an output style (e.g. deliverables as HTML). They are appended to
  the grounded prompt and are explicitly **subordinate** to the grounding/citation/untrusted
  rules, so they cannot make the assistant invent facts. Editable in *Dashboard → Edit*, with
  a starter persona template and an 8000-character limit. *Owner:* `server/src/llm/prompt.js`,
  `services/projects.js`, `routes/projects.js`, `web/src/views/DashboardView.jsx`.
  **← request #2 (the SQA persona) done.**

## H. Testing & verification

- [ ] **H1 — E2E uses the mock LLM + hash embeddings (Medium).** It proves wiring, grounding and
  citation integrity — not answer quality. *Work on it:* add an optional live-provider suite.
- [ ] **H2 — RAG eval is tiny and offline (Medium).** A wiring/grounding regression check, not a
  benchmark of your production model. *Work on it:* grow `server/eval/`.
- [ ] **H3 — No live provider integration tests (Medium).** Hosted adapters are not tested
  against real endpoints (they need keys). *Work on it:* opt-in integration tests.
- [ ] **H4 — No load/performance testing (Low).** Behaviour on large corpora is unknown.
  *Work on it:* add benchmarks.
- [ ] **H5 — No CI pipeline (Medium).** Tests must be run manually. *Work on it:* add a CI
  workflow (e.g. GitHub Actions).
- [ ] **H6 — Frontend has no unit tests (Medium).** Covered only indirectly by e2e.
  *Work on it:* add Vitest + React Testing Library.
- [ ] **H7 — Parser test coverage is uneven (Medium).** Some formats lack realistic fixtures.
  *Work on it:* `server/tests/unit/parsers.test.js`.

## I. Reliability & hangs

- [x] **I1 — The "Thinking…" forever spinner (resolved).** Asking a question could leave the
  UI spinning indefinitely: the SSE body had no deadline, the retrieval/embedding path had
  none either, and the assistant message was only written *after* generation, so a failure
  left a dangling user message. Now the assistant placeholder row is created **before** any
  work starts, every stage runs under a deadline, and every terminal path writes the
  outcome back to that row. *Owner:* `server/src/services/conversations.js`,
  `server/src/lib/http.js`, `web/src/api.js`.
- [x] **I2 — Client-side watchdog (resolved).** The web client aborts a stream that goes
  silent for 120 s or runs past 300 s, and reports `incomplete_stream` instead of hanging.
  *Owner:* `web/src/api.js`.
- [x] **I3 — Orphaned ingestion jobs (resolved).** A job left "processing" by a killed
  server is detected (`INGESTION_STALE_JOB_MS`) and re-queued at startup and every 60 s;
  the document/version status is reset to `pending`. *Owner:* `server/src/ingestion/worker.js`.
- [x] **I4 — PGlite transaction deadlock (resolved).** Calling the outer `db.query()` from
  inside `withTransaction()` deadlocks the single PGlite connection. The DB layer now
  detects this and throws `database_deadlock` instead of hanging, and every query runs
  under `DB_QUERY_TIMEOUT_MS`. *Owner:* `server/src/db/index.js`.
- [ ] **I5 — The original trigger was not reproduced (Medium).** The 2026-10-21 hang was
  diagnosed from database and log forensics (a job stuck at `parsing`, conversations with
  only the user message persisted); the exact trigger could not be reproduced
  deterministically afterwards, so the fix hardens every identified defect class rather
  than one specific cause. *Work on it:* keep the deadline + watchdog tests green.
- [ ] **I6 — Single-process PGlite limits concurrency (Medium).** Only one server process may
  open `storage/pgdata`, so the ingestion worker cannot be scaled out. *Work on it:* use a
  real PostgreSQL (`DATABASE_URL`).

---

*Compiled from the code, the README and the actual test runs. Update this list as items are
fixed — tick the box and add a one-line note with the date when you do.*
