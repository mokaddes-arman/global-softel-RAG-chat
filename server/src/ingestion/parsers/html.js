'use strict';

const cheerio = require('cheerio');
const { block } = require('./util');

const RELEVANT = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'pre', 'table', 'blockquote', 'dt', 'dd']);

function tableToMarkdown($, el) {
  const rows = [];
  $(el)
    .find('tr')
    .each((_, tr) => {
      const cells = [];
      $(tr)
        .find('th,td')
        .each((__, cell) => {
          cells.push(
            $(cell)
              .text()
              .replace(/\s+/g, ' ')
              .replace(/\|/g, '\\|')
              .trim(),
          );
        });
      if (cells.length) rows.push(cells);
    });
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const out = [pad(rows[0]).join(' | ')];
  out.push(Array(width).fill('---').join(' | '));
  for (const r of rows.slice(1)) out.push(pad(r).join(' | '));
  return out.join('\n');
}

function parseHtml(buffer) {
  const html = buffer.toString('utf8');
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();

  const title = ($('title').first().text() || '').trim();
  const blocks = [];
  let section = title || null;

  $('body').find('*').each((_, el) => {
    const tag = (el.tagName || '').toLowerCase();
    if (!RELEVANT.has(tag)) return;
    // Skip element if an ancestor (up to body) was already captured for tables.
    if (tag !== 'table' && $(el).parents('table').length) return;

    if (tag === 'table') {
      const md = tableToMarkdown($, el);
      if (md) blocks.push(block('table', md, { location: section ? { section } : {} }));
      return;
    }
    const text = $(el).text().replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    if (!text) return;

    if (/^h[1-6]$/.test(tag)) {
      section = text;
      blocks.push(block('heading', text, { level: Number(tag[1]), location: { section } }));
      return;
    }
    const kind = tag === 'li' || tag === 'dt' || tag === 'dd' ? 'list' : tag === 'pre' ? 'code' : 'paragraph';
    blocks.push(block(kind, text, { location: section ? { section } : {} }));
  });

  // Fallback for fragments without <body> content
  if (!blocks.length) {
    const text = $.root().text().replace(/\s+\n/g, '\n').trim();
    if (text) blocks.push(block('paragraph', text));
  }

  return {
    parser: 'html',
    blocks,
    metadata: { title: title || undefined, characters: html.length },
    warnings: [],
    ocrLikely: false,
  };
}

module.exports = { parseHtml };
