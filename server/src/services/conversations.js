'use strict';

const { query, withTransaction } = require('../db');
const { config } = require('../config/env');
const { logger } = require('../lib/logger');
const { AppError, Codes } = require('../lib/errors');
const { truncate } = require('../lib/ids');
const { retrieve } = require('../retrieval/hybrid');
const { runChat, listProviderModelCandidates } = require('../llm');
const { SYSTEM_PROMPT, buildAnswerPrompt, describeLocation } = require('../llm/prompt');
const { resolveChatProvider } = require('./providers');
const { resolveActiveEmbedding } = require('./embeddings');
const { requireProject } = require('./projects');

/**
 * Conversations, messages, citations and the end-to-end RAG answer flow.
 */

const CONTEXT_MESSAGE_LIMIT = 6;
const CONTEXT_CHAR_LIMIT = 1500;
const MAX_SOURCES_PERSISTED = 25;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
async function listConversations(projectId, { search, limit = 50, offset = 0, includeArchived = false } = {}) {
  const conditions = ['project_id = $1'];
  const params = [projectId];
  if (!includeArchived) conditions.push('archived = false');
  if (search) conditions.push(`title ILIKE $${params.push(`%${search}%`)}`);
  params.push(Math.min(limit, 200), Math.max(offset, 0));
  const { rows } = await query(
    `SELECT c.id, c.title, c.archived, c.provider, c.model, c.created_at, c.updated_at,
            (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message
     FROM conversations c
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.updated_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

async function getConversationRow(id) {
  const { rows } = await query('SELECT * FROM conversations WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getConversation(id, { includeSources = true } = {}) {
  const conversation = await getConversationRow(id);
  if (!conversation) throw new AppError('Conversation not found.', { code: Codes.NOT_FOUND, status: 404 });
  const { rows: messages } = await query(
    `SELECT id, role, content, status, provider, model, token_usage, latency_ms, error_code, error_message,
            retrieval_meta, created_at
     FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [id],
  );
  let sources = [];
  if (includeSources && messages.length) {
    const messageIds = messages.map((m) => m.id);
    const { rows } = await query(
      `SELECT id, message_id, chunk_id, document_id, document_version_id, rank, score, vector_rank, keyword_rank,
              rerank_score, citation_label, source_location, document_title, document_version_number, excerpt
       FROM message_sources WHERE message_id = ANY($1::uuid[]) ORDER BY rank ASC`,
      [messageIds],
    );
    sources = rows;
  }
  return { ...conversation, messages, sources };
}

async function createConversation(projectId, { title = 'New conversation', llmConfigId = null, provider = null, model = null, retrievalSettings = {} } = {}) {
  await requireProject(projectId);
  const { rows } = await query(
    `INSERT INTO conversations (project_id, title, llm_config_id, provider, model, retrieval_settings)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
    [projectId, truncate(title, 120), llmConfigId, provider, model, JSON.stringify(retrievalSettings)],
  );
  return rows[0];
}

async function updateConversation(id, { title, archived, llmConfigId, provider, model, retrievalSettings }) {
  const sets = [];
  const params = [];
  const push = (col, v) => sets.push(`${col} = $${params.push(v)}`);
  if (title !== undefined) push('title', truncate(title, 120));
  if (archived !== undefined) push('archived', archived);
  if (llmConfigId !== undefined) push('llm_config_id', llmConfigId);
  if (provider !== undefined) push('provider', provider);
  if (model !== undefined) push('model', model);
  if (retrievalSettings !== undefined) sets.push(`retrieval_settings = $${params.push(JSON.stringify(retrievalSettings))}::jsonb`);
  if (!sets.length) return getConversationRow(id);
  params.push(id);
  const { rows } = await query(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) throw new AppError('Conversation not found.', { code: Codes.NOT_FOUND, status: 404 });
  return rows[0];
}

async function deleteConversation(id) {
  const { rows } = await query('DELETE FROM conversations WHERE id = $1 RETURNING id', [id]);
  if (!rows[0]) throw new AppError('Conversation not found.', { code: Codes.NOT_FOUND, status: 404 });
  return rows[0];
}

/** Heuristic title (no extra LLM call), improved later if the user renames. */
function deriveTitle(question) {
  const cleaned = String(question).replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').slice(0, 8).join(' ');
  return truncate(words || 'New conversation', 80);
}

function buildConversationContext(messages) {
  const recent = messages.filter((m) => m.status === 'complete' && m.content).slice(-CONTEXT_MESSAGE_LIMIT);
  if (!recent.length) return null;
  return recent
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${truncate(m.content, CONTEXT_CHAR_LIMIT)}`)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// The RAG answer flow
// ---------------------------------------------------------------------------
/**
 * Reject when `promise` does not settle within `ms`. `onTimeout` is used to
 * abort the work that is still in flight so it does not keep running (and
 * keep holding resources) after the deadline passed.
 */
function withDeadline(promise, ms, label, { onTimeout, code = Codes.NETWORK_TIMEOUT, status = 504 } = {}) {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return Promise.resolve(promise);
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* ignore */
      }
      reject(new AppError(`${label} timed out after ${Math.round(ms / 1000)}s.`, { code, status }));
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * The Groq configuration to fall back to when OpenRouter is unusable
 * (missing key, rate limit, quota). Returns null when Groq is not set up.
 */
function groqFallback() {
  const apiKey = config.groq?.apiKey;
  if (!apiKey) return null;
  const model = config.groq.model || config.groq.models?.[0] || 'openai/gpt-oss-120b';
  return {
    configId: null,
    provider: 'groq',
    model,
    baseUrl: config.groq.baseUrl || 'https://api.groq.com/openai/v1',
    apiKey,
    extra: {},
    source: 'environment',
    name: `groq:${model}`,
  };
}

/**
 * The ordered list of attempts for one question.
 *
 * 1. The configured provider + model.
 * 2. The provider's other known models - a retired model must not fail the
 *    whole question.
 * 3. The fallback provider (OpenRouter -> Groq) and its known models.
 *
 * The list is built once per question so a failure cannot turn into an
 * unbounded retry loop.
 */
function buildAttempts(providerConfig) {
  const attempts = [{ ...providerConfig }];
  const addModels = (base) => {
    for (const model of listProviderModelCandidates(base.provider)) {
      if (attempts.some((a) => a.provider === base.provider && a.model === model)) continue;
      attempts.push({ ...base, model, name: `${base.provider}:${model}` });
    }
  };
  addModels(providerConfig);

  if (providerConfig.provider === 'openrouter') {
    const fallback = groqFallback();
    if (fallback) {
      attempts.push(fallback);
      addModels(fallback);
    }
  }
  return attempts;
}

/**
 * Pick the next attempt after a failure.
 *
 * - A retired/unknown model retries with the next known model of the *same*
 *   provider first (a different model on the same provider is usually enough).
 * - Any other failure (bad key, rate limit, provider error) jumps straight to
 *   the fallback provider.
 * - A timeout is never retried: the question is already out of budget.
 */
function nextAttempt(attempts, failedIndex, err) {
  if (err.code === Codes.NETWORK_TIMEOUT) return null;
  const failed = attempts[failedIndex];
  if (err.code === Codes.MODEL_NOT_FOUND) {
    const sameProvider = attempts.findIndex((a, i) => i > failedIndex && a.provider === failed.provider);
    if (sameProvider !== -1) return { index: sameProvider, attempt: attempts[sameProvider] };
  }
  const otherProvider = attempts.findIndex((a, i) => i > failedIndex && a.provider !== failed.provider);
  if (otherProvider === -1) return null;
  return { index: otherProvider, attempt: attempts[otherProvider] };
}

/**
 * Ask a question and (optionally) stream the answer.
 *
 * The flow is built so the UI can never end up spinning forever:
 *
 *   1. The assistant message row is created *before* anything that can fail.
 *      Every question therefore ends with a visible assistant bubble - the
 *      answer, a "no evidence" note, or the error message.
 *   2. Every stage runs under a deadline (provider resolution, retrieval,
 *      generation) and the whole ask has an overall deadline.
 *   3. A failure is always written back to the assistant message, so the
 *      conversation never keeps a dangling user message.
 *
 * @param {object} p
 * @param {string} p.conversationId
 * @param {string} p.question
 * @param {(event: object) => void} [p.emit]   streaming event sink (SSE)
 * @param {AbortSignal} [p.signal]
 * @param {object} [p.options] { llmConfigId, crossProject, projectIds, retrieval, allowUngroundedAnswer, stream, timeoutMs }
 */
async function ask({ conversationId, question, emit = () => {}, signal, options = {} }) {
  const conversation = await getConversationRow(conversationId);
  if (!conversation) throw new AppError('Conversation not found.', { code: Codes.NOT_FOUND, status: 404 });
  const project = await requireProject(conversation.project_id);

  const trimmed = String(question || '').trim();
  if (!trimmed) throw new AppError('The question is empty.', { code: Codes.VALIDATION, status: 422 });
  if (trimmed.length > 8000) throw new AppError('The question is too long (limit 8000 characters).', { code: Codes.VALIDATION, status: 413 });

  // Persist the user message first so history survives a failure mid-answer.
  const { rows: userRows } = await query(
    `INSERT INTO messages (conversation_id, project_id, role, content, status) VALUES ($1,$2,'user',$3,'complete') RETURNING *`,
    [conversationId, conversation.project_id, trimmed],
  );
  const userMessage = userRows[0];

  // Name the conversation from its very first question, before any work that
  // can fail. Deriving it later (only on success) left conversations stuck on
  // the default "New conversation" title whenever the answer failed or was
  // stopped, and made a retry unable to name the conversation at all.
  await titleFromFirstQuestion(conversationId, trimmed);

  // Create the assistant placeholder NOW, before anything that can fail.
  // Whatever happens next is written back to this row, so the conversation
  // always ends up with a visible assistant bubble.
  const { rows: placeholderRows } = await query(
    `INSERT INTO messages (conversation_id, project_id, role, content, status) VALUES ($1,$2,'assistant','','streaming') RETURNING id`,
    [conversationId, conversation.project_id],
  );
  const assistantMessageId = placeholderRows[0].id;

  const startedAt = Date.now();
  const deadline = startedAt + (Number(options.timeoutMs) || config.askTimeoutMs);

  // A local controller so a deadline can abort the work that is in flight,
  // while the caller's signal (the "stop" button) cancels the whole request.
  const work = new AbortController();
  const abortWork = () => {
    if (!work.signal.aborted) work.abort();
  };
  if (signal) {
    if (signal.aborted) abortWork();
    else signal.addEventListener('abort', abortWork, { once: true });
  }

  /** Write the final state of the assistant message and return the row. */
  const finalizeAssistant = async ({
    content = '',
    status = 'error',
    provider = null,
    model = null,
    errorCode = null,
    errorMessage = null,
    tokenUsage,
    latencyMs = null,
    retrievalMeta,
  }) => {
    const { rows } = await query(
      `UPDATE messages
          SET content = $2,
              status = $3,
              provider = COALESCE($4, provider),
              model = COALESCE($5, model),
              token_usage = COALESCE($6::jsonb, token_usage),
              latency_ms = COALESCE($7, latency_ms),
              retrieval_meta = COALESCE($8::jsonb, retrieval_meta),
              error_code = $9,
              error_message = $10
        WHERE id = $1
        RETURNING *`,
      [
        assistantMessageId,
        content,
        status,
        provider,
        model,
        tokenUsage === undefined ? null : JSON.stringify(tokenUsage || {}),
        latencyMs,
        retrievalMeta === undefined ? null : JSON.stringify(retrievalMeta || {}),
        errorCode,
        errorMessage,
      ],
    );
    return rows[0] || null;
  };

  let providerConfig = null;
  let partialText = '';
  let timedOut = false;
  /** Abort the work in flight and remember that a deadline was hit. */
  const onDeadline = () => {
    timedOut = true;
    abortWork();
  };

  try {
    const priorMessages = (
      await query(
        `SELECT role, content, status FROM messages WHERE conversation_id = $1 AND id <> $2 ORDER BY created_at ASC`,
        [conversationId, userMessage.id],
      )
    ).rows;
    const conversationContext = buildConversationContext(priorMessages);

    // --- provider selection -------------------------------------------------
    providerConfig = await withDeadline(
      resolveChatProvider({ configId: options.llmConfigId ?? conversation.llm_config_id }),
      deadline - Date.now(),
      'Resolving the AI provider',
      { onTimeout: onDeadline },
    );

    if (config.disableHostedAi) {
      const message =
        'Hosted AI is disabled (DISABLE_HOSTED_AI=true). Retrieval and document management still work, but answer generation is turned off. ' +
        'Set DISABLE_HOSTED_AI=false in .env to enable answers.';
      await finalizeAssistant({
        content: message,
        status: 'error',
        provider: providerConfig.provider,
        model: providerConfig.model,
        errorCode: Codes.HOSTED_AI_DISABLED,
        errorMessage: message,
        latencyMs: Date.now() - startedAt,
      });
      emit({ type: 'error', code: Codes.HOSTED_AI_DISABLED, message });
      return { ok: false, code: Codes.HOSTED_AI_DISABLED, message };
    }

    if (!providerConfig.apiKey && providerRequiresKey(providerConfig.provider)) {
      // OpenRouter without a key: fall back to Groq when one is configured.
      const fallback = groqFallback();
      if (fallback) {
        providerConfig = fallback;
      } else {
        const message =
          `The selected provider ("${providerConfig.name}") has no API key stored. ` +
          'Open Settings > AI Providers, add or fix the configuration, and test the connection.';
        await finalizeAssistant({
          content: message,
          status: 'error',
          provider: providerConfig.provider,
          model: providerConfig.model,
          errorCode: Codes.INVALID_API_KEY,
          errorMessage: message,
          latencyMs: Date.now() - startedAt,
        });
        emit({ type: 'error', code: Codes.INVALID_API_KEY, message });
        return { ok: false, code: Codes.INVALID_API_KEY, message };
      }
    }

    // Record the provider on the placeholder so the UI can show it while the
    // answer is still being generated.
    await query('UPDATE messages SET provider = $2, model = $3 WHERE id = $1', [
      assistantMessageId,
      providerConfig.provider,
      providerConfig.model,
    ]);

    // --- retrieval ----------------------------------------------------------
    emit({ type: 'status', stage: 'retrieving', message: 'Searching the project knowledge base…' });
    const retrievalSettings = { ...config.retrieval, ...(conversation.retrieval_settings || {}), ...(options.retrieval || {}) };

    const crossProject = Boolean(options.crossProject);
    let projectIds = [conversation.project_id];
    if (crossProject) {
      const requested = Array.isArray(options.projectIds) && options.projectIds.length ? options.projectIds : null;
      projectIds = requested || (await query(`SELECT id FROM projects WHERE status = 'active'`)).rows.map((r) => r.id);
    }

    let sources = [];
    let retrievalStats = null;
    let retrievalError = null;
    const retrievalBudget = Math.max(1000, Math.min(config.retrievalTimeoutMs, deadline - Date.now()));
    try {
      const embedding = await withDeadline(
        resolveActiveEmbedding(),
        retrievalBudget,
        'Preparing the embedding model',
        { onTimeout: onDeadline },
      );
      const result = await withDeadline(
        retrieve({
          question: trimmed,
          embedding,
          modelId: embedding.modelId,
          projectIds,
          settings: retrievalSettings,
          includeHistoricalVersions: Boolean(retrievalSettings.includeHistoricalVersions),
          signal: work.signal,
        }),
        retrievalBudget,
        'Searching the knowledge base',
        { onTimeout: onDeadline },
      );
      sources = result.sources;
      retrievalStats = result.stats;
    } catch (err) {
      retrievalError = err;
      logger.error({ err: err.message, code: err.code }, 'retrieval failed');
    }

    emit({
      type: 'retrieval',
      stats: retrievalStats,
      sourceCount: sources.length,
      error: retrievalError ? { code: retrievalError.code || 'retrieval_failed', message: retrievalError.message } : null,
    });

    // --- grounding decision -------------------------------------------------
    if (!sources.length && !options.allowUngroundedAnswer) {
      const explanation = retrievalError
        ? `I could not search the knowledge base: ${retrievalError.message}`
        : projectIds.length > 1
          ? `I found no relevant passages for this question in any of your projects' indexed documents. ` +
            'Try rephrasing, or check that the relevant documents have finished indexing.'
          : `I found no relevant passages for this question in the "${project.name}" knowledge base. ` +
            'The documents here do not appear to cover it. You can upload or re-index a relevant document, or rephrase the question. ' +
            'I will not guess an answer that the documents do not support.';
      const assistantMessage = await finalizeAssistant({
        content: explanation,
        status: 'complete',
        provider: providerConfig.provider,
        model: providerConfig.model,
        latencyMs: Date.now() - startedAt,
        retrievalMeta: { noEvidence: true, stats: retrievalStats, error: retrievalError?.message || null },
      });
      await touchConversation(conversationId, { provider: providerConfig.provider, model: providerConfig.model });
      emit({ type: 'sources', sources: [] });
      emit({ type: 'done', messageId: assistantMessageId, message: { id: assistantMessageId, content: explanation }, sources: [], noEvidence: true });
      return {
        ok: true,
        message: assistantMessage,
        messageId: assistantMessageId,
        content: explanation,
        sources: [],
        stats: retrievalStats,
        noEvidence: true,
      };
    }

    const promptSources = sources.map((s) => ({
      documentTitle: s.documentTitle,
      documentVersionNumber: s.documentVersionNumber,
      location: s.location,
      excerpt: truncate(s.excerpt, 1800),
    }));

    const answerPrompt = buildAnswerPrompt({
      question: trimmed,
      sources: promptSources,
      conversationContext,
      projectName: project.name,
      crossProject: projectIds.length > 1,
      projectInstructions: project.instructions,
    });

    // --- generation ---------------------------------------------------------
    emit({ type: 'status', stage: 'generating', message: 'Generating a grounded answer…' });
    emit({ type: 'sources', sources });

    const started = Date.now();
    let text = '';
    let usage = null;
    const wantsStream = options.stream !== false;

    const chatArgs = (attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      baseUrl: attempt.baseUrl,
      apiKey: attempt.apiKey,
      extra: attempt.extra,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: answerPrompt },
      ],
      signal: work.signal,
      onToken: wantsStream
        ? (delta) => {
            text += delta;
            partialText = text;
            emit({ type: 'token', text: delta });
          }
        : undefined,
    });

    // Try the configured provider first, then its other known models, then the
    // fallback provider. A retired model or a rate limit must not fail the
    // question outright.
    const attempts = buildAttempts(providerConfig);
    let attemptIndex = 0;
    let result;
    for (;;) {
      const attempt = attempts[attemptIndex];
      try {
        result = await withDeadline(
          runChat(chatArgs(attempt)),
          Math.max(1000, deadline - Date.now()),
          'Generating the answer',
          { onTimeout: onDeadline },
        );
        if (attempt.provider !== providerConfig.provider || attempt.model !== providerConfig.model) {
          providerConfig = attempt;
          await query('UPDATE messages SET provider = $2, model = $3 WHERE id = $1', [
            assistantMessageId,
            providerConfig.provider,
            providerConfig.model,
          ]);
        }
        break;
      } catch (err) {
        const next = nextAttempt(attempts, attemptIndex, err);
        if (!next) throw err;
        logger.warn(
          { err: err.message, from: attempt.name, to: next.attempt.name, code: err.code },
          'provider attempt failed, trying the next one',
        );
        attemptIndex = next.index;
      }
    }

    if (!wantsStream) text = result.text;
    partialText = text;
    if (result.usage) usage = result.usage;
    else if (text) usage = { estimated_completion_tokens: Math.ceil(text.length / 4) };

    const actualModel = result.model || providerConfig.model;
    const latencyMs = Date.now() - started;
    const finalText = text.trim() || '(The provider returned an empty answer.)';

    let assistantMessage = null;
    await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE messages SET content = $2, status = 'complete', provider = $3, model = $4, token_usage = $5::jsonb,
                latency_ms = $6, retrieval_meta = $7::jsonb, error_code = NULL, error_message = NULL
         WHERE id = $1
         RETURNING *`,
        [
          assistantMessageId,
          finalText,
          providerConfig.provider,
          actualModel,
          JSON.stringify(usage || {}),
          latencyMs,
          JSON.stringify({ stats: retrievalStats, sourceCount: sources.length, provider: providerConfig.provider, model: actualModel }),
        ],
      );
      assistantMessage = rows[0] || null;
      await persistSources(tx, assistantMessageId, conversation.project_id, sources);
    });

    await touchConversation(conversationId, { provider: providerConfig.provider, model: actualModel });
    emit({ type: 'done', messageId: assistantMessageId, latencyMs, usage, model: actualModel });

    return {
      ok: true,
      message: assistantMessage,
      messageId: assistantMessageId,
      content: finalText,
      sources,
      stats: retrievalStats,
      usage,
      model: actualModel,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const aborted = Boolean(signal?.aborted) || err.status === 499;
    const code = timedOut ? Codes.NETWORK_TIMEOUT : aborted ? Codes.GENERATION_FAILED : err.code || Codes.GENERATION_FAILED;
    const message = aborted ? 'Generation stopped by the user.' : err.message || 'Answer generation failed.';

    logger.error({ err: err.message, code }, 'ask failed');
    await finalizeAssistant({
      content: partialText,
      status: aborted ? 'aborted' : 'error',
      provider: providerConfig?.provider ?? null,
      model: providerConfig?.model ?? null,
      errorCode: code,
      errorMessage: message,
      latencyMs,
    }).catch((writeErr) => {
      logger.error({ err: writeErr.message }, 'could not store the assistant error message');
    });
    emit({ type: 'error', code, message, partial: partialText });
    return { ok: false, code, message, messageId: assistantMessageId, partial: partialText };
  }
}

function providerRequiresKey(providerId) {
  // Both hosted providers need an API key; the offline mock provider does not.
  return providerId === 'openrouter' || providerId === 'groq';
}

async function persistSources(tx, messageId, projectId, sources) {
  const limited = sources.slice(0, MAX_SOURCES_PERSISTED);
  for (const s of limited) {
    await tx.query(
      `INSERT INTO message_sources
         (message_id, project_id, chunk_id, document_id, document_version_id, rank, score, vector_rank, keyword_rank,
          rerank_score, citation_label, source_location, document_title, document_version_number, excerpt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        messageId,
        projectId,
        s.chunkId,
        s.documentId,
        s.documentVersionId,
        s.rank,
        s.score,
        s.vectorRank,
        s.keywordRank,
        s.rerankScore,
        `[${s.rank}]`,
        s.sourceLocation || describeLocation(s.location),
        s.documentTitle,
        s.documentVersionNumber,
        truncate(s.excerpt, 2000),
      ],
    );
  }
}

/**
 * Name a conversation from its first question.
 *
 * Only the first question names it, and only when the title is still the
 * default — a title supplied at creation time or set with "Rename" is never
 * overwritten.
 */
async function titleFromFirstQuestion(conversationId, question) {
  await query(
    `UPDATE conversations
        SET title = $2
      WHERE id = $1
        AND (title IS NULL OR btrim(title) = '' OR title = 'New conversation')
        AND (SELECT COUNT(*)::int FROM messages WHERE conversation_id = $1 AND role = 'user') = 1`,
    [conversationId, deriveTitle(question)],
  );
}

async function touchConversation(conversationId, { provider, model }) {
  await query(
    `UPDATE conversations
        SET updated_at = now(),
            provider = COALESCE($2, provider),
            model = COALESCE($3, model)
      WHERE id = $1`,
    [conversationId, provider, model],
  );
}

/** Retrieve only - used by the "inspect evidence" panel and by tests. */
async function retrieveEvidence({ projectId, question, options = {} }) {
  const embedding = await resolveActiveEmbedding();
  const projectIds = options.crossProject ? (options.projectIds?.length ? options.projectIds : (await query(`SELECT id FROM projects WHERE status='active'`)).rows.map((r) => r.id)) : [projectId];
  return retrieve({
    question,
    embedding,
    modelId: embedding.modelId,
    projectIds,
    settings: { ...config.retrieval, ...(options.retrieval || {}) },
    includeHistoricalVersions: Boolean(options.retrieval?.includeHistoricalVersions),
  });
}

module.exports = {
  listConversations,
  getConversation,
  getConversationRow,
  createConversation,
  updateConversation,
  deleteConversation,
  ask,
  retrieveEvidence,
  buildConversationContext,
  deriveTitle,
};
