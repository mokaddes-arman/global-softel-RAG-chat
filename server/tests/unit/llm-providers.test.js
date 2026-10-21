/* globals describe, it, expect */
const {
  listLlmProviders,
  listLlmProviderIds,
  listProviderModelCandidates,
  SUPPORTED_LLM_PROVIDERS,
} = require('../../src/llm');

describe('LLM provider registry', () => {
  it('registers exactly the two supported hosted providers', () => {
    const ids = listLlmProviderIds();
    expect(ids).toContain('groq');
    expect(ids).toContain('openrouter');
    // Everything that is not the offline test mock has been removed.
    expect(SUPPORTED_LLM_PROVIDERS).toEqual(['openrouter', 'groq']);
    for (const removed of ['openai', 'anthropic', 'google', 'opencode', 'ollama']) {
      expect(ids).not.toContain(removed);
    }
  });

  it('exposes the fields the settings UI depends on', () => {
    for (const p of listLlmProviders()) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.label).toBe('string');
      expect(typeof p.requiresKey).toBe('boolean');
      expect(typeof p.supportsStreaming).toBe('boolean');
    }
  });

  it('requires an API key for both hosted providers', () => {
    const byId = Object.fromEntries(listLlmProviders().map((p) => [p.id, p]));
    expect(byId.openrouter.requiresKey).toBe(true);
    expect(byId.groq.requiresKey).toBe(true);
  });

  it('lists known models for every hosted provider so a retired model is not fatal', () => {
    for (const id of SUPPORTED_LLM_PROVIDERS) {
      const candidates = listProviderModelCandidates(id);
      expect(candidates.length, `${id} must have at least one known model`).toBeGreaterThan(0);
      expect(candidates.every((m) => typeof m === 'string' && m.length > 0)).toBe(true);
      // The default model must be one of the candidates, otherwise the very
      // first request would fail with "model not found".
      const provider = listLlmProviders().find((p) => p.id === id);
      expect(candidates).toContain(provider.defaultModel);
    }
  });

  it('returns no candidates for an unknown provider', () => {
    expect(listProviderModelCandidates('openai')).toEqual([]);
    expect(listProviderModelCandidates('nope')).toEqual([]);
  });
});
