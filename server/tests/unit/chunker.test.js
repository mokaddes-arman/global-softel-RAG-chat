'use strict';

/* globals describe, it, expect */
const { chunkDocument, splitTextBySize } = require('../../src/ingestion/chunker');

const block = (kind, text, location = {}) => ({ kind, text, location });

describe('chunker', () => {
  it('carries the active heading into the chunk that follows it', () => {
    const chunks = chunkDocument(
      {
        blocks: [
          block('heading', 'Authentication', { section: 'Authentication' }),
          block('paragraph', 'Users sign in with SSO.', { section: 'Authentication' }),
        ],
      },
      { chunkSizeChars: 500, chunkOverlapChars: 0 },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('Authentication');
    expect(chunks[0].content).toContain('Users sign in with SSO');
    expect(chunks[0].metadata.sections).toContain('Authentication');
  });

  it('never merges tables into surrounding prose', () => {
    const chunks = chunkDocument(
      {
        blocks: [
          block('paragraph', 'The following table lists the fields.'),
          block('table', 'Worksheet: Fields\nname | type\n--- | ---\nid | uuid', { sheet: 'Fields' }),
          block('paragraph', 'The table above is authoritative.'),
        ],
      },
      { chunkSizeChars: 500, chunkOverlapChars: 0 },
    );
    const tableChunk = chunks.find((c) => c.metadata.blockKinds.includes('table'));
    expect(tableChunk).toBeTruthy();
    expect(tableChunk.content).toContain('Worksheet: Fields');
    expect(tableChunk.content).not.toContain('The table above is authoritative');
    expect(tableChunk.metadata.sheets).toContain('Fields');
  });

  it('splits long prose but keeps an overlap between consecutive chunks', () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} about the system.`).join(' ');
    const chunks = chunkDocument({ blocks: [block('paragraph', long)] }, { chunkSizeChars: 200, chunkOverlapChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.charCount).toBeLessThanOrEqual(400);
  });

  it('records page numbers and derives the lowest page for the location', () => {
    const chunks = chunkDocument(
      {
        blocks: [
          block('paragraph', 'Requirement on page two.', { page: 2 }),
          block('paragraph', 'More detail on page three.', { page: 3 }),
        ],
      },
      { chunkSizeChars: 500, chunkOverlapChars: 0 },
    );
    expect(chunks[0].metadata.pages).toEqual([2, 3]);
    expect(chunks[0].metadata.location.page).toBe(2);
  });

  it('splitTextBySize prefers natural boundaries', () => {
    const parts = splitTextBySize('aaa\n\nbbb\n\nccc', 10);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toContain('aaa');
  });

  it('returns nothing for an empty document', () => {
    expect(chunkDocument({ blocks: [] })).toEqual([]);
  });
});
