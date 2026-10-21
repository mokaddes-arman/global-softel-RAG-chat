'use strict';

const mammoth = require('mammoth');
const { parseHtml } = require('./html');

/**
 * DOCX via mammoth. Mammoth converts Word heading styles into real <h1>..<h6>
 * and tables into <table>, so we reuse the HTML parser to recover structure
 * (headings -> sections, tables preserved) instead of flat text.
 */
async function parseDocx(buffer, ctx = {}) {
  let result;
  try {
    result = await mammoth.convertToHtml(
      { buffer },
      {
        styleMap: [
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Heading 3'] => h3:fresh",
          "p[style-name='Heading 4'] => h4:fresh",
        ],
      },
    );
  } catch (err) {
    const msg = String(err?.message || err);
    if (/password|encrypt/i.test(msg)) {
      const e = new Error(`"${ctx.filename}" is password-protected and cannot be read.`);
      e.code = 'encrypted_document';
      throw e;
    }
    const e = new Error(`Could not read Word document "${ctx.filename}": ${msg}`);
    e.code = 'parse_failed';
    throw e;
  }

  const warnings = [];
  for (const m of result.messages || []) {
    if (m.type === 'warning' || m.type === 'error') warnings.push(`DOCX: ${m.message}`);
  }

  const parsed = parseHtml(Buffer.from(result.value || '', 'utf8'));
  // DOCX has no reliable page numbers without layout; sections are the location.
  return {
    parser: 'docx',
    blocks: parsed.blocks,
    metadata: { ...parsed.metadata, characters: (result.value || '').length },
    warnings: warnings.slice(0, 20),
    ocrLikely: false,
  };
}

module.exports = { parseDocx };
