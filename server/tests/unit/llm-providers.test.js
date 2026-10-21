/* globals describe, it, expect */
const { listLlmProviders, listLlmProviderIds, SUPPORTED_LLM_PROVIDERS } = require('../../src/llm');

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
});
