'use strict';

const { block, paragraphsFromText } = require('./util');
const { normaliseText } = require('./text');

/**
 * RTF: no reliable pure-JS RTF parser exists for every dialect, so we apply a
 * careful control-word stripper that keeps the visible text. This is documented
 * as "best effort" - formatting and complex fields may be lost, but the words
 * are preserved for retrieval.
 */

const CP1252_HIGH = {
  0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6', 0x89: '\u2030', 0x8a: '\u0160',
  0x8b: '\u2039', 0x8c: '\u0152', 0x8e: '\u017D', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02DC', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203A', 0x9c: '\u0153',
  0x9e: '\u017E', 0x9f: '\u0178',
};

function parseRtf(buffer) {
  let rtf = normaliseText(buffer);

  // Remove binary payloads (images, objects).
  rtf = rtf.replace(/\{\\pict[\s\S]*?\}/g, ' ').replace(/\{\\object[\s\S]*?\}/g, ' ');

  // Unicode escapes: \uN?  (signed 16-bit, followed by a fallback character)
  rtf = rtf.replace(/\\u(-?\d+)\s?\??/g, (_, n) => {
    let code = Number(n);
    if (code < 0) code += 65536;
    try {
      return String.fromCharCode(code);
    } catch {
      return '';
    }
  });

  // Hex escapes: \'hh  (code page 1252 approximation)
  rtf = rtf.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => {
    const code = parseInt(hex, 16);
    if (code >= 0x80 && CP1252_HIGH[code]) return CP1252_HIGH[code];
    return code >= 0x20 ? String.fromCharCode(code) : '';
  });

  // Structural control words -> whitespace
  rtf = rtf
    .replace(/\\par\b/g, '\n\n')
    .replace(/\\line\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(/\\cell\b/g, '\t')
    .replace(/\\row\b/g, '\n')
    .replace(/\\page\b/g, '\n\f\n');

  // Drop ignored destinations and remaining control symbols/words.
  rtf = rtf
    .replace(/\{\\\*[\s\S]*?\}/g, ' ')
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, ' ')
    .replace(/\\[^a-zA-Z]/g, '')
    .replace(/[{}]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const pages = rtf.split('\f');
  const blocks = [];
  pages.forEach((pageText, idx) => {
    const location = pages.length > 1 ? { page: idx + 1 } : {};
    blocks.push(...paragraphsFromText(pageText, location));
  });

  return {
    parser: 'rtf',
    blocks,
    metadata: { characters: rtf.length },
    warnings: ['RTF parsing is best-effort: formatting and complex fields may be simplified.'],
    ocrLikely: false,
  };
}

module.exports = { parseRtf };
