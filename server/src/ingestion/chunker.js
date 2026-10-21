'use strict';

const { estimateTokens } = require('../lib/ids');

/**
 * Structure-aware chunker.
 *
 * - Headings start a new chunk and are carried into it so the surrounding
 *   context is retrievable ("Section X ...").
 * - Tables and code blocks become their own chunks (never merged with prose),
 *   because mixing them degrades both retrieval quality and readability.
 * - Long prose is split near natural boundaries with a configurable overlap.
 */

const DEFAULT_MAX_MULTIPLIER = 1.6;

function splitTextBySize(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return [s];
  const parts = [];
  let remaining = s;
  while (remaining.length > maxChars) {
    // Prefer a paragraph, then a line, then a sentence, then a hard cut.
    let cut = remaining.lastIndexOf('\n\n', maxChars);
    if (cut < maxChars * 0.5) cut = remaining.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.5) cut = remaining.lastIndexOf('. ', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    parts.push(remaining.slice(0, cut + 1).trim());
    remaining = remaining.slice(cut + 1);
  }
  if (remaining.trim()) parts.push(remaining.trim());
  return parts.filter(Boolean);
}

function mergeLocations(blocks) {
  const location = {};
  const pages = new Set();
  const sheets = new Set();
  const slides = new Set();
  const sections = new Set();
  const kinds = new Set();
  for (const b of blocks) {
    const loc = b.location || {};
    if (loc.page !== undefined) pages.add(loc.page);
    if (loc.sheet !== undefined) sheets.add(loc.sheet);
    if (loc.slide !== undefined) slides.add(loc.slide);
    if (loc.section !== undefined) sections.add(loc.section);
    if (loc.rowRange !== undefined && location.rowRange === undefined) location.rowRange = loc.rowRange;
    if (loc.label && location.label === undefined) location.label = loc.label;
    if (b.kind) kinds.add(b.kind);
  }
  if (pages.size) location.page = Math.min(...pages);
  if (sheets.size) location.sheet = [...sheets][0];
  if (slides.size) location.slide = Math.min(...slides);
  if (sections.size) location.section = [...sections][sections.size - 1];

  return {
    location,
    pages: [...pages].sort((a, b) => a - b),
    sheets: [...sheets],
    slides: [...slides].sort((a, b) => a - b),
    sections: [...sections],
    blockKinds: [...kinds],
  };
}

function buildChunk(index, text, blocks) {
  const meta = mergeLocations(blocks);
  const content = text.trim();
  return {
    index,
    content,
    charCount: content.length,
    tokenCount: estimateTokens(content),
    metadata: meta,
  };
}

function chunkDocument(parsed, options = {}) {
  const chunkSizeChars = Math.max(200, options.chunkSizeChars ?? 1200);
  const overlapChars = Math.max(0, Math.min(options.chunkOverlapChars ?? 180, Math.floor(chunkSizeChars / 2)));
  const maxStandaloneChars = Math.floor(chunkSizeChars * DEFAULT_MAX_MULTIPLIER);
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  const chunks = [];

  let pending = []; // blocks accumulated for the current prose chunk
  let pendingText = '';
  let activeHeading = null;

  const flushProse = () => {
    if (!pending.length || !pendingText.trim()) {
      pending = [];
      pendingText = '';
      return;
    }
    const text = pendingText.trim();
    chunks.push(buildChunk(chunks.length, text, pending));
    const tail = overlapChars > 0 ? text.slice(-overlapChars) : '';
    pending = [];
    pendingText = tail ? `…${tail}` : '';
  };

  for (const raw of blocks) {
    const b = { kind: raw.kind || 'paragraph', text: String(raw.text || '').trim(), location: raw.location, level: raw.level };
    if (!b.text) continue;

    if (b.kind === 'heading') {
      flushProse();
      activeHeading = b;
      pending.push(b);
      pendingText = b.text;
      continue;
    }

    if (b.kind === 'table' || b.kind === 'code') {
      flushProse();
      const parts = splitTextBySize(b.text, maxStandaloneChars);
      const blockList = activeHeading ? [activeHeading, b] : [b];
      parts.forEach((part, i) => {
        const list = i === 0 ? blockList : [b];
        chunks.push(buildChunk(chunks.length, part, list));
      });
      continue;
    }

    // Prose-like blocks (paragraph, list, note). A single block that is itself
    // larger than the target size (common for PDF text, which often arrives as
    // one giant paragraph) is split near natural boundaries first.
    const pieces = b.text.length > chunkSizeChars ? splitTextBySize(b.text, chunkSizeChars) : [b.text];
    for (const piece of pieces) {
      const current = { ...b, text: piece };
      const addition = pendingText ? `\n\n${piece}` : piece;
      if (pendingText.length + addition.length > chunkSizeChars && pending.length) {
        flushProse();
        if (activeHeading) pending.push(activeHeading);
        pendingText = pendingText ? `${pendingText}\n\n${piece}` : piece;
        pending.push(current);
      } else {
        pendingText += addition;
        pending.push(current);
      }
    }
  }
  flushProse();

  // Drop chunks that ended up with no meaningful content.
  const cleaned = chunks.filter((c) => c.content.replace(/…/g, '').trim().length > 0);
  return cleaned.map((c, i) => ({ ...c, index: i }));
}

module.exports = { chunkDocument, splitTextBySize };
