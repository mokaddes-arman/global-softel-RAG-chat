'use strict';

/* globals describe, it, expect */
const { buildAnswerPrompt } = require('../../src/llm/prompt');

const baseArgs = {
  question: 'What is the rate limit per minute?',
  sources: [
    {
      documentTitle: 'Platform API Specification',
      documentVersionNumber: 2,
      location: { section: 'Rate limits' },
      excerpt: 'The Platform API enforces a rate limit of 120 requests per minute.',
    },
  ],
  conversationContext: '',
  projectName: 'Platform',
  crossProject: false,
};

describe('buildAnswerPrompt project instructions', () => {
  it('includes the operator instructions block when instructions are set', () => {
    const prompt = buildAnswerPrompt({
      ...baseArgs,
      projectInstructions: 'You are a Senior SQA Engineer. Deliver QA artefacts as HTML.',
    });

    expect(prompt).toContain('PROJECT INSTRUCTIONS');
    expect(prompt).toContain('You are a Senior SQA Engineer. Deliver QA artefacts as HTML.');
    // Wrapped in a delimited, clearly labelled block.
    expect(prompt).toContain('<<<PROJECT_INSTRUCTIONS');
    expect(prompt).toContain('PROJECT_INSTRUCTIONS>>>');
    // The block is explicitly subordinate to the grounding/citation rules.
    expect(prompt).toMatch(/must never override those rules/i);
    // The evidence block (and its untrusted framing) is still present.
    expect(prompt).toContain('<<<EVIDENCE');
    expect(prompt).toContain('untrusted document excerpts');
  });

  it('omits the instructions block when instructions are blank', () => {
    for (const value of [undefined, null, '', '   ']) {
      const prompt = buildAnswerPrompt({ ...baseArgs, projectInstructions: value });
      expect(prompt).not.toContain('PROJECT INSTRUCTIONS');
      expect(prompt).not.toContain('<<<PROJECT_INSTRUCTIONS');
      // Everything else is unaffected.
      expect(prompt).toContain('<<<EVIDENCE');
    }
  });
});
