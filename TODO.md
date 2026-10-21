# Global Softel RAG Chat — Implementation Checklist

Status legend: [x] done · [~] in progress · [ ] not started

## Stage 1 — Inspection & architecture
- [x] Inspect repository, environment, Node/npm versions, missing prerequisites
- [x] Map backend API surface, schema, services, providers, retrieval
- [x] Confirm PostgreSQL: app ships an embedded PGlite+pgvector backend (no server install needed); `DATABASE_URL` enables real PostgreSQL
- [x] Document architecture + limitations in README

## Stage 2 — Foundation (backend already present)
- [x] Monorepo workspaces (`server`, `web`) + root scripts
- [x] Config via `.env` (`server/src/config/env.js`)
- [x] DB layer with PostgreSQL **and** embedded PGlite+pgvector (`server/src/db`)
- [x] Migrations `001_init.sql`, `002_vector_index.sql` + runner/rollback
- [x] Health & system-status endpoints
- [x] Verify server boots and serves the API end-to-end (manual smoke test — `npm start` serves API + built SPA on `:3001`, `/api/health` = ok, `/` returns the SPA)

## Stage 3 — Projects & ingestion (backend present, fixes needed)
- [x] Project CRUD service + routes
- [x] Safe file storage (path traversal protection)
- [x] Parser registry (PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, JSON, YAML, HTML, XML, RTF, ODT/ODS/ODP, code/log)
- [x] Structure-aware chunker
- [x] Local embeddings (transformers.js / Ollama / OpenAI / hash) + registry
- [x] DB-backed ingestion job queue + worker + retry
- [x] **FIX**: projects router was mounted at `/api` instead of `/api/projects` (all project routes 404)
- [x] **FIX**: chunker must split oversized single prose blocks
- [x] **FIX**: PDF `ocrLikely` threshold flagged small real PDFs as scans

## Stage 4 — Retrieval & RAG (backend present, fixes needed)
- [x] Hybrid vector + keyword retrieval with RRF fusion + optional rerank
- [x] Project isolation enforced in SQL
- [x] Grounded system prompt + evidence blocks (prompt-injection safe)
- [x] Provider abstraction (OpenAI-compatible, Anthropic, Google, mock) + streaming
- [x] Source citations persisted to `message_sources`
- [x] **FIX**: `/projects/:id/search` should support explicit historical-version search
- [x] **FIX**: return a clear reason when a scoped project has no indexed content
- [x] **FIX**: PGlite `withTransaction` deadlocked (used outer `db.query` instead of the transaction handle) — hung project deletion and every upload/version write

## Stage 5 — Chat & UI (built from scratch)
- [x] Vite + React + Tailwind scaffold (`web/vite.config.js`, `index.html`, `src/main.jsx`)
- [x] API client + app state (`web/src/api.js`, `web/src/store.jsx`)
- [x] Sidebar: app identity, project selector, create project, documents nav, conversations, search, settings
- [x] Chat: messages, streaming (SSE), stop generation, sources, evidence viewer, copy, retry
- [x] Markdown rendering (tables, code) via `react-markdown` + `remark-gfm`
- [x] Project dashboard + document table with real stats
- [x] Provider/settings page (add/test/edit/delete configs, masked keys)
- [x] Light/dark theme, responsive, accessible
- [x] Empty/loading/error states

## Stage 6 — Reliability & security
- [x] AES-256-GCM API-key encryption at rest + masking
- [x] Request validation (Zod), CORS allow-list, security headers, parameterised SQL
- [x] Document versioning (immutable history, explicit activation)
- [x] Prompt-injection handling
- [x] Verify destructive-operation confirmations in the UI (projects, documents, conversations and provider configs all use `ConfirmDialog`)

## Stage 7 — QA & verification
- [x] Fix failing unit tests, get the full backend suite green — **92 passed (9 files)**
- [x] RAG evaluation dataset + runner (`server/scripts/rag-eval.mjs`) — **8/8 retrieval + grounded-answer smoke pass**
- [x] Playwright end-to-end tests (`e2e/`, `playwright.config.js`) — **11 passed** (real browser + real backend: onboarding, upload→ask→cite, grounding, abstention, isolation)
- [x] Prerequisite check script (`scripts/check-prereqs.mjs`) and `server/scripts/check.mjs` — both green
- [x] Run the app, verify upload→ask→cite workflow and check console/backend errors — verified via the browser-driven e2e (`03-ui-workflow`) with zero page/console errors, plus a manual `npm start` boot smoke test
- [x] README with install/migrate/run/test commands + honest limitations (`README.md`)

## Stage 8 — Per-project persona + HTML deliverables (RAG "act as" instructions)
**Goal:** let each project give the assistant a role and output style (e.g. *Senior SQA Engineer*)
without weakening grounding. Deliverables (plans, mappings, test cases, test reports, bug reports,
feature listings) are returned as professional, self-contained **HTML** and shown in a sandboxed
preview with Copy/Download.
**Decisions locked:** per-project **editable** · **strict abstention kept** · ask-back only when
*some* evidence exists · HTML **authored by the model** (no hardcoded templates) · sandboxed
preview (never render model HTML directly in the app page).

Backend
- [x] Migration `003_project_instructions.sql` — add nullable `projects.instructions text`
- [x] `services/projects.js` — include `instructions` in `PROJECT_COLUMNS`; accept it in create + update
- [x] `routes/projects.js` — validate `instructions` on create/update (trim, max 8000, nullable)
- [x] `llm/prompt.js` — `buildAnswerPrompt({ projectInstructions })` appends an operator-instructions block, explicitly **subordinate** to grounding/citation/untrusted-content rules
- [x] `services/conversations.js` — pass `project.instructions` into the answer prompt
- [x] Verified `web/src/api.js` `createProject`/`updateProject` forward the body as-is (no stripping)

Frontend
- [x] `web/src/lib/persona.js` — reusable "Senior SQA Engineer" instruction template (role + HTML output convention)
- [x] `web/src/components/HtmlDeliverable.jsx` — sandboxed iframe preview + Copy + Download (never injects HTML into the app page)
- [x] `web/src/components/Markdown.jsx` — detect fenced ` ```html ` blocks and render via `<HtmlDeliverable>`; all other Markdown unchanged
- [x] `web/src/views/DashboardView.jsx` — add **Instructions / persona** textarea (+ char counter + "Load SQA persona template" button) to the Edit Project modal; send `instructions` on save
- [x] Manual UI check — edit project → save instructions → reload → value persists (automated by the `03-ui-workflow` persona UI test)

Tests & docs
- [x] `server/tests/unit/prompt.test.js` — instructions block present when set, absent when blank
- [x] `server/tests/integration/projects.test.js` — create + PATCH round-trip for `instructions`
- [x] e2e (`02-api.spec.js`) — project instructions round-trip over HTTP
- [x] All suites green — backend (`npm test`) **96 passed**, e2e (`npm run test:e2e`) **13 passed**, RAG eval (`npm run eval:rag`) **8/8**, `npm run check` all checks passed
- [x] Update `README.md` — document per-project instructions + HTML deliverables
- [x] Tick `LIMITATIONS.md` item **G9** (custom persona now supported)

Notes
- Grounding/abstention untouched: the model is still only called when evidence exists.
- The model authors the HTML templates itself; nothing is hardcoded beyond the starter persona.
- **Fixed along the way:** `web/src/store.jsx` cleared the persisted active project while the project list was still loading, so a reload could silently fall back to the first (alphabetically earliest) project. Now it waits for the list to load before validating.

## Stage 9 — Provider consolidation (OpenRouter + Groq) + `/model-usage` page
**Goal:** reduce the LLM surface to the two providers that are actually needed — **OpenRouter**
(primary) and **Groq** (fallback) — remove every other provider adapter, and keep the
`/model-usage` page that reports per-model token usage.

**Decisions locked:** OpenRouter + Groq are the **only** providers that may answer questions ·
both speak the OpenAI chat-completions protocol, so they share one adapter · the offline
`mock` adapter is registered **only** when `NODE_ENV=test` (or under Vitest), so it can never
answer a real question · OpenRouter → Groq is the one automatic cross-provider fallback ·
usage is sourced from **this app's own** completed answers.

Backend
- [x] `llm/index.js` — rewritten: `providers.openrouter` + `providers.groq` via one shared
  `createOpenAICompatibleProvider()`; `providers.openai`, `providers.anthropic`,
  `providers.google` and the whole OpenCode adapter deleted
- [x] `llm/index.js` — `SUPPORTED_LLM_PROVIDERS`, `listLlmProviderIds()`, `isSupportedLlmProvider()`;
  `mock` registered only when `config.isTest`
- [x] `config/env.js` + `.env`/`.env.example` — `DEFAULT_LLM_PROVIDER=openrouter`,
  `DEFAULT_LLM_MODEL=deepseek/deepseek-chat-v3-0324:free`; `OPENCODE_*` variables removed
- [x] `services/providers.js` — env fallback via `isSupportedLlmProvider()`
- [x] `services/conversations.js` — `providerRequiresKey()` only for openrouter/groq;
  OpenRouter → Groq fallback on rate limit / quota / missing key
- [x] `routes/usage.js` + `services/usage.js` — `GET /model-usage/catalog` is now derived from
  the provider configs stored in the DB (not the ambient environment), so it is deterministic
- [x] `server/tests/unit/opencode.test.js` deleted; `server/tests/unit/llm-providers.test.js` added

Frontend
- [x] `web/src/views/SettingsView.jsx` — provider dropdown fallbacks `openai` → `openrouter`
- [x] `web/src/views/ModelUsageView.jsx` — per-model usage page (day/week/month/year + custom range)

Tests & docs
- [x] `server/tests/integration/{providers,chat,security,usage}.test.js` — models updated to
  `llama-3.1-8b-instant` / `deepseek/deepseek-chat-v3-0324:free`
- [x] All suites green — backend (`npm test`) **107 passed**, e2e (`npm run test:e2e`) **14 passed**
- [x] Docs — README (provider section, env table, API), `LIMITATIONS.md` (D2, D10–D13)

Notes
- Grounding/abstention untouched: the provider is only called when evidence exists.
- The embedding providers (`local`, `ollama`, `openai`, `hash`) are **not** LLM answer
  providers and were deliberately left alone.

## Stage 10 — Reliability: the "Thinking…" forever spinner
**Goal:** a question must always end with a visible assistant bubble — an answer, an
abstention, or an error — and the UI must never spin forever.

**Defects found (from DB + log forensics on the 2026-10-21 hang):**
- `consumeSSE()` had no deadline: the abort timer only covered the response *headers* and was
  cleared in `finally`, leaving the body unbounded.
- The retrieval / embedding path had no timeout.
- The assistant message row was created *after* generation, so a failure left the
  conversation with only the user message.
- A PGlite `withTransaction()` that called the outer `db.query()` deadlocked the single
  connection and the query never returned.
- An ingestion job orphaned by a killed server stayed "processing" forever.

Backend
- [x] `lib/http.js` — rewritten: the abort timer stays armed until the body is consumed
  (`withBodyDeadline` re-wraps the body in a `ReadableStream`); `consumeSSE()` gained an
  overall `timeoutMs` **and** an `idleTimeoutMs`
- [x] `services/conversations.js` — `ask()` rewritten: the assistant placeholder row is
  inserted **before** any work starts; `withDeadline()` guards provider resolution,
  retrieval and generation; a local `AbortController` handles both deadlines and the user's
  stop button; every terminal path writes back to the assistant message
- [x] `db/index.js` — `withQueryTimeout` (`DB_QUERY_TIMEOUT_MS`) + an `AsyncLocalStorage`
  guard that throws `database_deadlock` instead of deadlocking
- [x] `lib/errors.js` — `DATABASE_TIMEOUT` and `DATABASE_DEADLOCK` codes
- [x] `ingestion/pipeline.js` — parse / embedding-batch / overall job deadlines; a
  failure-proof `markFailed()` with a plain-statement fallback
- [x] `ingestion/worker.js` — `recoverStaleJobs()` requeues orphaned jobs and resets the
  document/version status to `pending`; stale-aware `claimJob()`; startup + 60 s recovery

Frontend
- [x] `web/src/api.js` — `askStream()` watchdog: 120 s idle timeout, 300 s overall timeout,
  and `incomplete_stream` when the stream ends without a terminal event

Config
- [x] `.env` / `.env.example` — `ASK_TIMEOUT_MS`, `RETRIEVAL_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS`,
  `LLM_REQUEST_TIMEOUT_MS`, `LLM_STREAM_IDLE_TIMEOUT_MS`, `EMBEDDING_REQUEST_TIMEOUT_MS`,
  `INGESTION_PARSE_TIMEOUT_MS`, `INGESTION_JOB_TIMEOUT_MS`, `INGESTION_STALE_JOB_MS`

Verified
- [x] Live check on the real OpenRouter key — upload → index (97 chunks) → ask → 8 cited
  sources; the previously stuck job `5da6667d` and document `68fe229f-…` are indexed again
- [x] All suites green — backend (`npm test`) **107 passed** (12 files), e2e
  (`npm run test:e2e`) **14 passed**
- [x] Docs — README (deadline table, limitations), `LIMITATIONS.md` (new section I)

## Deliverables status
- [x] Backend (Node/Express/CommonJS)
- [x] PostgreSQL schema + pgvector retrieval
- [x] Local document storage + multi-format ingestion
- [x] Local embeddings + configurable hosted LLM providers
- [x] Encrypted multi-key provider management
- [x] Grounded answers with verifiable citations
- [x] React frontend
- [x] Automated tests green (107 backend + 14 e2e + 8/8 RAG eval)
- [x] Per-project persona/instructions + sandboxed HTML deliverables (Stage 8)
- [x] OpenRouter + Groq as the only answer providers (automatic fallback) + `/model-usage` page (Stage 9)
- [x] No-hang reliability: stage deadlines, assistant placeholder, SSE/body deadlines, stale-job recovery (Stage 10)
- [x] `.env.example` / `.gitignore` / README / PowerShell setup docs
