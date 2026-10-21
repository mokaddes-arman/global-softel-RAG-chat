'use strict';

const { block, paragraphsFromText, countWords } = require('./util');

/** Strip a UTF-8 BOM and normalise line endings. */
function normaliseText(buffer) {
  return buffer
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
}

/** Detect binary content that was mislabelled as text (e.g. a .txt that is really a zip). */
function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.1;
}

function parsePlainText(buffer, ctx = {}) {
  if (looksBinary(buffer)) {
    const err = new Error(
      `"${ctx.filename || 'file'}" does not look like UTF-8 text (it appears to be binary). ` +
        'If it is a document, upload the original format instead.',
    );
    err.code = 'parse_failed';
    throw err;
  }
  const raw = normaliseText(buffer);
  const blocks = [];
  // Form-feed (\f) is the conventional page separator in extracted text.
  const pages = raw.split('\f');
  pages.forEach((pageText, idx) => {
    const location = pages.length > 1 ? { page: idx + 1 } : {};
    blocks.push(...paragraphsFromText(pageText, location));
  });
  return {
    parser: 'text',
    blocks,
    metadata: { characters: raw.length, words: countWords(raw) },
    warnings: [],
    ocrLikely: false,
  };
}

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
const SETEXT_RE = /^(=+|-{2,})\s*$/;

/** Markdown: heading-aware chunking source. */
function parseMarkdown(buffer) {
  const raw = normaliseText(buffer);
  const lines = raw.split('\n');
  const blocks = [];
  let section = null;
  let bufferLines = [];
  let inFence = false;
  let fenceLines = [];

  const flushParagraph = () => {
    const text = bufferLines.join('\n').trim();
    if (text) blocks.push(block('paragraph', text, { location: section ? { section } : {} }));
    bufferLines = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (/^\s*(```|~~~)/.test(line)) {
      if (!inFence) {
        flushParagraph();
        inFence = true;
        fenceLines = [line];
      } else {
        fenceLines.push(line);
        blocks.push(block('code', fenceLines.join('\n'), { location: section ? { section } : {} }));
        fenceLines = [];
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      flushParagraph();
      section = h[2];
      blocks.push(block('heading', h[2], { level: h[1].length, location: { section } }));
      continue;
    }
    // Setext headings (=== / ---) under a single line of text
    if (SETEXT_RE.test(line) && bufferLines.length === 1 && bufferLines[0].trim()) {
      const title = bufferLines[0].trim();
      section = title;
      blocks.push(block('heading', title, { level: line.trim()[0] === '=' ? 1 : 2, location: { section } }));
      bufferLines = [];
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    bufferLines.push(line);
  }
  if (inFence && fenceLines.length) blocks.push(block('code', fenceLines.join('\n')));
  flushParagraph();

  return {
    parser: 'markdown',
    blocks,
    metadata: { characters: raw.length, words: countWords(raw) },
    warnings: [],
    ocrLikely: false,
  };
}

/** Structured logs: keep timestamps as part of the text so retrieval can match them. */
function parseLog(buffer, ctx = {}) {
  const raw = normaliseText(buffer);
  const lines = raw.split('\n');
  const blocks = [];
  const GROUP = 25;
  for (let i = 0; i < lines.length; i += GROUP) {
    const group = lines.slice(i, i + GROUP).filter((l) => l.trim() !== '');
    if (!group.length) continue;
    blocks.push(block('code', group.join('\n'), { location: { label: `lines ${i + 1}-${i + group.length}` } }));
  }
  return {
    parser: 'log',
    blocks,
    metadata: { lineCount: lines.length, words: countWords(raw) },
    warnings: [],
    ocrLikely: false,
  };
}

/** Source code / configuration: keep indentation, split on blank lines. */
function parseCode(buffer, ctx = {}) {
  const raw = normaliseText(buffer);
  const segments = raw.split(/\n{2,}/).map((s) => s.replace(/\s+$/, '')).filter((s) => s.trim());
  const blocks = segments.map((s) => block('code', s, { location: { label: ctx.filename } }));
  return {
    parser: 'code',
    blocks,
    metadata: { characters: raw.length, lines: raw.split('\n').length },
    warnings: [],
    ocrLikely: false,
  };
}

module.exports = { parsePlainText, parseMarkdown, parseLog, parseCode, normaliseText, looksBinary };
