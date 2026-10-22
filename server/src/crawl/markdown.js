'use strict';

const cheerio = require('cheerio');

/**
 * HTML -> Markdown conversion for crawled web pages.
 *
 * A crawled page is stored as a `.md` document, so the conversion has to keep
 * the structure that makes retrieval useful: headings, lists, tables, code and
 * links. Everything else (scripts, styles, navigation noise) is dropped.
 */

const DROP_SELECTOR = 'script, style, noscript, svg, canvas, iframe, template, link[rel="preload"]';

const INLINE_WRAPPERS = {
  strong: '**',
  b: '**',
  em: '*',
  i: '*',
  code: '`',
};

function collapse(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/** Render the inline content of a node as a single markdown line. */
function renderInline($, node) {
  if (!node) return '';
  if (node.type === 'text') return collapse(node.data);
  if (node.type !== 'tag' && node.type !== 'root') return '';

  const tag = (node.name || '').toLowerCase();
  if (tag === 'br') return '\n';
  if (tag === 'img') {
    const src = $(node).attr('src') || '';
    const alt = collapse($(node).attr('alt') || '');
    if (!src) return alt;
    return `![${alt}](${src})`;
  }
  if (tag === 'a') {
    const href = $(node).attr('href') || '';
    const text = renderChildrenInline($, node);
    if (!href) return text;
    if (!text) return '';
    return `[${text}](${href})`;
  }

  const children = renderChildrenInline($, node);
  const wrapper = INLINE_WRAPPERS[tag];
  if (wrapper && children) return `${wrapper}${children}${wrapper}`;
  return children;
}

function renderChildrenInline($, node) {
  const parts = [];
  for (const child of node.children || []) {
    parts.push(renderInline($, child));
  }
  return collapse(parts.join(' '));
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
          cells.push(collapse(renderChildrenInline($, cell)).replace(/\|/g, '\\|'));
        });
      if (cells.length) rows.push(cells);
    });
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const out = [`| ${pad(rows[0]).join(' | ')} |`];
  out.push(`| ${Array(width).fill('---').join(' | ')} |`);
  for (const r of rows.slice(1)) out.push(`| ${pad(r).join(' | ')} |`);
  return out.join('\n');
}

function renderList($, el, depth = 0) {
  const ordered = (el.name || '').toLowerCase() === 'ol';
  let index = Number.parseInt($(el).attr('start') || '1', 10) || 1;
  const indent = '  '.repeat(depth);
  const lines = [];

  $(el)
    .children('li')
    .each((_, li) => {
      const marker = ordered ? `${index}.` : '-';
      const clone = $(li).clone();
      clone.children('ul,ol').remove();
      const text = collapse(renderChildrenInline($, clone.get(0)));
      lines.push(`${indent}${marker} ${text}`.trimEnd());
      $(li)
        .children('ul,ol')
        .each((__, nested) => {
          const nestedMd = renderList($, nested, depth + 1);
          if (nestedMd) lines.push(nestedMd);
        });
    });

  return lines.join('\n');
}

function renderPre($, el) {
  const clone = $(el).clone();
  clone.find('br').replaceWith('\n');
  const code = clone.text().replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
  const language = (($(el).find('code').attr('class') || '').match(/language-([\w+-]+)/) || [])[1] || '';
  if (!code) return '';
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

/** Render the block-level children of a node into markdown blocks. */
function renderBlocks($, node) {
  const blocks = [];

  for (const child of node.children || []) {
    if (child.type === 'text') {
      const text = collapse(child.data);
      if (text) blocks.push(text);
      continue;
    }
    if (child.type !== 'tag') continue;

    const tag = (child.name || '').toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      const text = collapse(renderChildrenInline($, child));
      if (text) blocks.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
      continue;
    }
    if (tag === 'p') {
      const text = collapse(renderChildrenInline($, child));
      if (text) blocks.push(text);
      continue;
    }
    if (tag === 'hr') {
      blocks.push('---');
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      const md = renderList($, child);
      if (md) blocks.push(md);
      continue;
    }
    if (tag === 'pre') {
      const md = renderPre($, child);
      if (md) blocks.push(md);
      continue;
    }
    if (tag === 'blockquote') {
      const inner = renderBlocks($, child)
        .map((b) => b.split('\n').map((l) => `> ${l}`).join('\n'))
        .join('\n\n');
      if (inner.trim()) blocks.push(inner);
      continue;
    }
    if (tag === 'table') {
      const md = tableToMarkdown($, child);
      if (md) blocks.push(md);
      continue;
    }
    if (tag === 'dl') {
      const parts = [];
      $(child)
        .children('dt,dd')
        .each((_, el) => {
          const text = collapse(renderChildrenInline($, el));
          if (!text) return;
          parts.push(el.name.toLowerCase() === 'dt' ? `**${text}**` : `: ${text}`);
        });
      if (parts.length) blocks.push(parts.join('\n'));
      continue;
    }
    if (tag === 'figure') {
      const inner = renderBlocks($, child);
      if (inner.length) blocks.push(inner.join('\n\n'));
      continue;
    }
    if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;

    // Generic container: recurse, but keep inline-only elements as text.
    const hasBlockChildren = (child.children || []).some(
      (c) =>
        c.type === 'tag' &&
        ['p', 'div', 'section', 'article', 'main', 'ul', 'ol', 'table', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dl', 'figure', 'hr'].includes(
          (c.name || '').toLowerCase(),
        ),
    );
    if (hasBlockChildren) {
      const inner = renderBlocks($, child);
      if (inner.length) blocks.push(inner.join('\n\n'));
      continue;
    }
    const text = collapse(renderChildrenInline($, child));
    if (text) blocks.push(text);
  }

  // Remove empty blocks and collapse runs of blank lines.
  return blocks
    .map((b) => b.trim())
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Convert an HTML document to Markdown.
 *
 * @param {string|Buffer} html
 * @returns {{title: string|null, markdown: string}}
 */
function htmlToMarkdown(html) {
  const source = Buffer.isBuffer(html) ? html.toString('utf8') : String(html || '');
  const $ = cheerio.load(source);
  $(DROP_SELECTOR).remove();

  const title =
    (($('meta[property="og:title"]').attr('content') || '').trim() ||
      ($('title').first().text() || '').trim() ||
      ($('h1').first().text() || '').trim() ||
      null);

  const root = $('body').length ? $('body').get(0) : $.root().get(0);
  let markdown = renderBlocks($, root);

  // A page whose body is empty but whose <title> exists still carries content
  // worth indexing.
  if (!markdown && title) markdown = `# ${title}`;

  return { title: title || null, markdown };
}

module.exports = { htmlToMarkdown, renderBlocks, tableToMarkdown };
