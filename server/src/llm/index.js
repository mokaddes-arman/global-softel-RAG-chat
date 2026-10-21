'use strict';

const { config } = require('../config/env');
const { logger } = require('../lib/logger');
const { AppError, Codes } = require('../lib/errors');
const { request, consumeSSE, mapProviderHttpError } = require('../lib/http');

/**
 * LLM provider abstraction.
 *
 * Exactly two hosted providers can answer questions:
 *
 *   - `openrouter` : https://openrouter.ai/api/v1
 *   - `groq`       : https://api.groq.com/openai/v1
 *
 * Both speak the OpenAI chat-completions protocol, so they share one adapter.
 *
 * A third, offline `mock` adapter exists for the automated test suite and the
 * end-to-end run only. It is registered exclusively when the process runs with
 * NODE_ENV=test (or under Vitest), so it can never answer a real question in
 * a normal run.
 *
 * Every provider exposes:
 *   chat({ messages, model, baseUrl, apiKey, extra, signal, onToken, maxTokens })
 *     -> { text, usage, finishReason, model }
 *   testConnection({ model, baseUrl, apiKey }) -> { ok, message, latencyMs }
 *
 * `onToken(delta)` is called for each streamed chunk when streaming is used;
 * the full text is also returned so non-streaming callers work identically.
 */

/** The provider ids that are allowed to answer questions. */
const SUPPORTED_LLM_PROVIDERS = ['openrouter', 'groq'];

const providers = {};

function normaliseMessages(messages) {
  return (messages || [])
    .filter((m) => m && m.content)
    .map((m) => ({ role: m.role, content: String(m.content) }));
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat completions
// ---------------------------------------------------------------------------
// One adapter covers both supported providers: they differ only in base URL,
// default model and the model list they advertise.
function createOpenAICompatibleProvider({ id, label, defaultBaseUrl, defaultModel, knownModels = [], requiresKey = true }) {
  return {
    id,
    label,
    requiresKey,
    requiresBaseUrl: false,
    defaultBaseUrl,
    defaultModel,
    knownModels,
    supportsStreaming: true,
    async chat({ messages, model, baseUrl, apiKey, signal, onToken, maxTokens, temperature }) {
      const base = (baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
      const body = {
        model,
        messages: normaliseMessages(messages),
        temperature: temperature ?? 0.2,
        stream: Boolean(onToken),
      };
      if (maxTokens) body.max_tokens = maxTokens;

      const res = await request(
        `${base}/chat/completions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        },
        { timeoutMs: config.llmRequestTimeoutMs, signal, service: label },
      );

      if (!res.ok) throw mapProviderHttpError(res.status, await res.text().catch(() => ''), label);

      if (!body.stream) {
        const json = await res.json();
        const text = json.choices?.[0]?.message?.content ?? '';
        return { text, usage: json.usage || null, finishReason: json.choices?.[0]?.finish_reason, model: json.model || model };
      }

      let text = '';
      let usage = null;
      let finishReason = null;
      await consumeSSE(
        res,
        (data) => {
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            return;
          }
          if (json.usage) usage = json.usage;
          const choice = json.choices?.[0];
          if (!choice) return;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta?.content;
          if (delta) {
            text += delta;
            onToken(delta);
          }
        },
        {
          timeoutMs: config.llmRequestTimeoutMs,
          idleTimeoutMs: config.llmStreamIdleTimeoutMs,
          service: label,
        },
      );
      return { text, usage, finishReason, model };
    },
    async testConnection({ model, baseUrl, apiKey }) {
      const base = (baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
      const started = Date.now();
      const res = await request(
        `${base}/models`,
        { method: 'GET', headers: { authorization: `Bearer ${apiKey}` } },
        { timeoutMs: 15000, service: label },
      );
      if (!res.ok) {
        if (res.status === 404) {
          return this.testCompletion({ model, baseUrl: base, apiKey, started });
        }
        throw mapProviderHttpError(res.status, await res.text().catch(() => ''), label);
      }
      const json = await res.json().catch(() => ({}));
      const ids = (json.data || []).map((m) => m.id).filter(Boolean);
      const found = !model || ids.length === 0 || ids.includes(model);
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: found
          ? `Connected. ${ids.length} model(s) available${model ? ` and "${model}" is present.` : '.'}`
          : `Connected, but "${model}" was not listed. It may still work if the server allows it.`,
        models: ids.slice(0, 200),
      };
    },
    async testCompletion({ model, baseUrl, apiKey, started = Date.now() }) {
      const res = await request(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        },
        { timeoutMs: 20000, service: label },
      );
      if (!res.ok) throw mapProviderHttpError(res.status, await res.text().catch(() => ''), label);
      return { ok: true, latencyMs: Date.now() - started, message: 'Connected (verified with a 1-token completion).' };
    },
  };
}

providers.openrouter = createOpenAICompatibleProvider({
  id: 'openrouter',
  label: 'OpenRouter',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: 'deepseek/deepseek-chat-v3-0324:free',
  knownModels: [
    { id: 'deepseek/deepseek-chat-v3-0324:free' },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
  ],
});

providers.groq = createOpenAICompatibleProvider({
  id: 'groq',
  label: 'Groq',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'llama-3.1-8b-instant',
  knownModels: [
    { id: 'llama-3.1-8b-instant' },
    { id: 'qwen/qwen3-32b' },
  ],
});

// ---------------------------------------------------------------------------
// Mock provider (automated tests / offline demos - never calls the network)
// ---------------------------------------------------------------------------
// Registered ONLY in test mode. In a normal run the registry contains the two
// hosted providers and nothing else, so the mock can never answer a question.
if (config.isTest) {
  providers.mock = {
    id: 'mock',
    label: 'Mock (offline testing only)',
    requiresKey: false,
    requiresBaseUrl: false,
    supportsStreaming: true,
    defaultBaseUrl: '',
    defaultModel: 'mock',
    knownModels: [{ id: 'mock' }],
    async chat({ messages, onToken }) {
      const lastUser = [...normaliseMessages(messages)].reverse().find((m) => m.role === 'user');
      const evidenceCount = (String(lastUser?.content || '').match(/^\[\d+\] Document:/gm) || []).length;
      const text = evidenceCount
        ? `[mock] I found ${evidenceCount} evidence block(s) for: "${(lastUser?.content || '').slice(-200)}". (Mock provider: configure a real provider in Settings for actual answers.)`
        : '[mock] No evidence blocks were supplied. (Mock provider - configure a real provider in Settings.)';
      if (onToken) {
        for (const word of text.split(' ')) onToken(`${word} `);
      }
      return { text, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, finishReason: 'stop', model: 'mock' };
    },
    async testConnection() {
      return { ok: true, latencyMs: 0, message: 'Mock provider always succeeds (no network call).' };
    },
  };
}

function getLlmProvider(id) {
  const p = providers[id];
  if (!p) {
    throw new AppError(
      `Unknown LLM provider "${id}". Supported: ${Object.keys(providers).join(', ')}.`,
      { code: Codes.VALIDATION, status: 400 },
    );
  }
  return p;
}

function listLlmProviders() {
  return Object.values(providers).map((p) => ({
    id: p.id,
    label: p.label,
    requiresKey: p.requiresKey,
    requiresBaseUrl: p.requiresBaseUrl,
    defaultBaseUrl: p.defaultBaseUrl,
    supportsStreaming: p.supportsStreaming,
    defaultModel: p.defaultModel || null,
    knownModels: p.knownModels || [],
  }));
}

/** The ids of the providers that may answer questions. */
function listLlmProviderIds() {
  return Object.keys(providers);
}

/** True when the given provider id is registered and may answer questions. */
function isSupportedLlmProvider(id) {
  return Boolean(providers[id]);
}

/** Run a chat completion through the selected provider. */
async function runChat({ provider, ...options }) {
  const impl = getLlmProvider(provider);
  const started = Date.now();
  const result = await impl.chat(options);
  logger.debug({ provider, model: options.model, ms: Date.now() - started }, 'llm chat completed');
  return result;
}

async function testProviderConnection({ provider, ...options }) {
  const impl = getLlmProvider(provider);
  return impl.testConnection(options);
}

module.exports = {
  getLlmProvider,
  listLlmProviders,
  listLlmProviderIds,
  isSupportedLlmProvider,
  runChat,
  testProviderConnection,
  providers,
  SUPPORTED_LLM_PROVIDERS,
};
