'use strict';

const cheerio = require('cheerio');
const { block } = require('./util');

/**
 * HTML parser for uploaded files.
 *
 * Real-world HTML is rarely a neat sequence of <p> tags: most pages wrap their
 * text in <div>/<section>/<article> containers (and often <span>s inside those).
 * The parser therefore walks the whole body and flushes text at every
 * block-level boundary, instead of only looking at a fixed list of semantic
 * tags. That way container-based markup is indexed just as reliably as <p>.
 */

const DROP = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'template',
  'iframe',
  'object',
  'embed',
  'canvas',
  'head',
]);

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const LIST_CONTAINERS = new Set(['ul', 'ol', 'dl']);
const LIST_ITEMS = new Set(['li', 'dt', 'dd']);

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'caption',
  'center',
  'details',
  'div',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hr',
  'li',
  'dt',
  'dd',
  'main',
  'nav',
  'p',
  'section',
  'summary',
  'td',
  'th',
  'tr',
  'tfoot',
  'thead',
]);

const DROP_SELECTOR = [...DROP].join(', ');

/**
 * Decode the raw file. Most HTML is UTF-8, but saved pages and exports from
 * Windows tools often declare another charset (or carry a BOM). Decoding the
 * bytes correctly is the difference between readable text and mojibake.
 */
function decodeHtml(input) {
  if (!Buffer.isBuffer(input)) return String(input ?? '');
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    return input.subarray(3).toString('utf8');
  }
  if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(input.subarray(2));
  }
  if (input.length >= 2 && input[0] === 0xfe && input[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(input.subarray(2));
  }

  const head = input.subarray(0, 2048).toString('latin1');
  const declared =
    /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1] ||
    /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1] ||
    'utf-8';
  const charset = declared.toLowerCase();
  if (charset === 'utf-8' || charset === 'utf8') return input.toString('utf8');
  try {
    return new TextDecoder(charset).decode(input);
  } catch {
    return input.toString('utf8');
  }
}

/** Collapse source whitespace while keeping explicit line breaks (<br>). */
function normalise(text) {
  return String(text ?? '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

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
  const html = decodeHtml(buffer);
  const $ = cheerio.load(html);
  // Read the title before dropping <head> (wholesale, since it only holds
  // metadata/scripts and would otherwise leak into the body fallback).
  const title = ($('title').first().text() || '').trim();
  $(DROP_SELECTOR).remove();

  const blocks = [];
  let section = title || null;
  let textBuffer = '';
  let listDepth = 0;

  const flush = (kind) => {
    const text = normalise(textBuffer);
    textBuffer = '';
    if (!text) return;
    const resolved = kind || (listDepth > 0 ? 'list' : 'paragraph');
    blocks.push(block(resolved, text, { location: section ? { section } : {} }));
  };

  const walk = (node) => {
    if (node.type === 'text') {
      // Collapse source formatting whitespace; <br> adds a real line break.
      textBuffer += node.data.replace(/\s+/g, ' ');
      return;
    }
    if (node.type !== 'tag') return;

    const tag = (node.name || '').toLowerCase();
    if (DROP.has(tag)) return;

    if (HEADINGS.has(tag)) {
      flush();
      const text = normalise($(node).text());
      if (text) {
        const level = Number(tag[1]);
        section = text;
        blocks.push(block('heading', text, { level, location: { section } }));
      }
      return;
    }

    if (tag === 'table') {
      flush();
      const md = tableToMarkdown($, node);
      if (md) blocks.push(block('table', md, { location: section ? { section } : {} }));
      return;
    }

    if (tag === 'pre') {
      flush();
      const text = $(node).text().replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
      if (text.trim()) blocks.push(block('code', text, { location: section ? { section } : {} }));
      return;
    }

    if (tag === 'br') {
      textBuffer += '\n';
      return;
    }

    if (tag === 'img') {
      const alt = normalise($(node).attr('alt'));
      if (alt) {
        textBuffer += `${textBuffer && !textBuffer.endsWith(' ') ? ' ' : ''}${alt}`;
      }
      return;
    }

    const isList = LIST_CONTAINERS.has(tag) || LIST_ITEMS.has(tag);
    const isBlock = isList || BLOCK_TAGS.has(tag);

    if (isBlock) flush();
    if (LIST_CONTAINERS.has(tag)) listDepth += 1;
    for (const child of node.children || []) walk(child);
    if (LIST_CONTAINERS.has(tag)) listDepth -= 1;
    if (isBlock) flush();
  };

  const root = $('body').get(0) || $.root().get(0);
  walk(root);
  flush();

  return {
    parser: 'html',
    blocks,
    metadata: { title: title || undefined, characters: html.length },
    warnings: [],
    ocrLikely: false,
  };
}

module.exports = { parseHtml };
