'use strict';

/**
 * Shared helpers for the ingestion pipeline.
 *
 * Parsers convert a file into a normalised document:
 *
 *   {
 *     parser: string,
 *     blocks: Block[],            // ordered, structural units
 *     metadata: object,           // title, author, pageCount, sheetNames, ...
 *     warnings: string[],
 *     ocrLikely: boolean,
 *   }
 *
 * Block = {
 *   kind: 'heading' | 'paragraph' | 'list' | 'table' | 'code' | 'note',
 *   text: string,
 *   level?: number,               // heading level
 *   location?: {                  // best-effort source location
 *     page?: number, sheet?: string, slide?: number, section?: string,
 *     rowRange?: [number, number], label?: string,
 *   },
 * }
 */

function block(kind, text, extra = {}) {
  return { kind, text: String(text ?? '').trim(), ...extra };
}

/** Split a block of prose into paragraph-sized blocks, keeping locations. */
function paragraphsFromText(text, location = {}) {
  const src = String(text ?? '');
  const chunks = src
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/[ \t]+\n/g, '\n').trim())
    .filter(Boolean);
  const out = [];
  for (const p of chunks.length ? chunks : [src.trim()].filter(Boolean)) {
    out.push(block('paragraph', p, { location }));
  }
  return out;
}

/** Very small HTML/XML entity decoder used by regex-based extractors. */
function decodeEntities(input) {
  const s = String(input ?? '');
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(cp) {
  try {
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
  } catch {
    return '';
  }
}

/** Normalise a detected MIME/extension into a canonical format key. */
function normaliseExt(ext) {
  return String(ext || '')
    .toLowerCase()
    .replace(/^\./, '');
}

function joinBlocksToText(blocks) {
  return blocks.map((b) => b.text).filter(Boolean).join('\n\n');
}

function countWords(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

module.exports = {
  block,
  paragraphsFromText,
  decodeEntities,
  normaliseExt,
  joinBlocksToText,
  countWords,
};
