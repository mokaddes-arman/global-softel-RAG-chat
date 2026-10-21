'use strict';

const { block, paragraphsFromText } = require('./util');

/**
 * PDF text extraction via pdf-parse (built on PDF.js).
 * Preserves per-page text so citations can point at a page number.
 */
async function parsePdf(buffer, ctx = {}) {
  let PDFParse;
  try {
    ({ PDFParse } = require('pdf-parse'));
  } catch (err) {
    const e = new Error('PDF support is unavailable: the pdf-parse dependency failed to load.');
    e.code = 'parse_failed';
    e.cause = err;
    throw e;
  }

  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let textResult;
  let infoResult = null;
  try {
    textResult = await parser.getText();
    try {
      infoResult = await parser.getInfo();
    } catch {
      infoResult = null;
    }
  } catch (err) {
    const name = err?.name || err?.constructor?.name || '';
    const msg = String(err?.message || err);
    if (/password|encrypt/i.test(name) || /password|encrypt/i.test(msg)) {
      const e = new Error(
        `"${ctx.filename}" is password-protected or encrypted and cannot be read. Remove the password and upload again.`,
      );
      e.code = 'encrypted_document';
      throw e;
    }
    const e = new Error(`Could not read PDF "${ctx.filename}": ${msg}`);
    e.code = 'parse_failed';
    e.cause = err;
    throw e;
  } finally {
    await parser.destroy?.().catch(() => {});
  }

  const pages = Array.isArray(textResult?.pages) ? textResult.pages : [];
  const blocks = [];
  let totalChars = 0;

  for (const page of pages) {
    const pageText = String(page.text || '').replace(/\u0000/g, '').trim();
    totalChars += pageText.length;
    if (!pageText) continue;
    blocks.push(...paragraphsFromText(pageText, { page: page.num }));
  }

  const pageCount = textResult?.total || pages.length || 0;
  const avgCharsPerPage = pageCount ? totalChars / pageCount : totalChars;
  // Scanned PDFs yield almost no extractable text. The threshold is deliberately
  // low so that short but genuinely text-based documents are not mislabelled.
  const MIN_CHARS_PER_PAGE = 20;
  const ocrLikely = pageCount > 0 && avgCharsPerPage < MIN_CHARS_PER_PAGE;
  const warnings = [];
  if (ocrLikely) {
    warnings.push(
      `Very little selectable text was found (${Math.round(avgCharsPerPage)} characters per page). ` +
        'This PDF is probably a scan and needs OCR before it can be searched. See README > Scanned PDFs.',
    );
  }

  const info = infoResult?.info || {};
  return {
    parser: 'pdf',
    blocks,
    metadata: {
      pageCount,
      title: info.Title || undefined,
      author: info.Author || undefined,
      subject: info.Subject || undefined,
      creator: info.Creator || undefined,
      producer: info.Producer || undefined,
      characters: totalChars,
    },
    warnings,
    ocrLikely,
  };
}

module.exports = { parsePdf, block };
