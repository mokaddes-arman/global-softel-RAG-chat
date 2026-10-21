'use strict';

const JSZip = require('jszip');
const { block, decodeEntities } = require('./util');
const { isOle, decodeXmlEntities } = require('./pptx');

/** Convert ODF inline markup (`<text:p>` content) into plain text. */
function odfInnerToText(inner) {
  return decodeXmlEntities(
    String(inner)
      .replace(/<text:s\b[^>]*\/>/g, ' ')
      .replace(/<text:tab\b[^>]*\/>/g, '\t')
      .replace(/<text:line-break\b[^>]*\/>/g, '\n')
      .replace(/<text:soft-page-break\b[^>]*\/>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .trim();
}

async function loadContentXml(buffer, filename) {
  if (isOle(buffer)) {
    const e = new Error(`"${filename}" appears to be an encrypted legacy file and cannot be read.`);
    e.code = 'encrypted_document';
    throw e;
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    const e = new Error(`Could not open "${filename}" as an OpenDocument file: ${err.message}`);
    e.code = 'parse_failed';
    throw e;
  }
  const contentFile = zip.file('content.xml');
  if (!contentFile) {
    const e = new Error(`"${filename}" is missing content.xml and may be corrupt.`);
    e.code = 'parse_failed';
    throw e;
  }
  const contentXml = await contentFile.async('string');
  let title;
  const metaFile = zip.file('meta.xml');
  if (metaFile) {
    const metaXml = await metaFile.async('string');
    const m = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(metaXml);
    if (m) title = decodeEntities(m[1]).trim() || undefined;
  }
  return { contentXml, title };
}

/** ODT: headings + paragraphs in document order. */
async function parseOdt(buffer, ctx = {}) {
  const { contentXml, title } = await loadContentXml(buffer, ctx.filename);
  const blocks = [];
  let section = title || null;

  const re = /<text:(h|p)\b[^>]*>([\s\S]*?)<\/text:\1>/g;
  let m;
  while ((m = re.exec(contentXml))) {
    const isHeading = m[1] === 'h';
    const text = odfInnerToText(m[2]);
    if (!text) continue;
    if (isHeading) {
      const levelMatch = /text:outline-level="(\d+)"/.exec(m[0]);
      section = text;
      blocks.push(block('heading', text, { level: levelMatch ? Number(levelMatch[1]) : 1, location: { section } }));
    } else {
      blocks.push(block('paragraph', text, { location: section ? { section } : {} }));
    }
  }

  return {
    parser: 'odt',
    blocks,
    metadata: { title },
    warnings: blocks.length ? [] : ['No text content was found in the document.'],
    ocrLikely: false,
  };
}

/** ODS: worksheet name + row groups (mirrors the XLSX behaviour). */
async function parseOds(buffer, ctx = {}) {
  const { contentXml, title } = await loadContentXml(buffer, ctx.filename);
  const blocks = [];
  const warnings = [];
  const sheetNames = [];

  const tableRe = /<table:table\b[^>]*table:name="([^"]*)"[^>]*>([\s\S]*?)<\/table:table>/g;
  let t;
  while ((t = tableRe.exec(contentXml))) {
    const sheetName = decodeEntities(t[1]) || `Sheet${sheetNames.length + 1}`;
    sheetNames.push(sheetName);
    const rows = [];
    const rowRe = /<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g;
    let r;
    while ((r = rowRe.exec(t[2]))) {
      const cells = [];
      const cellRe = /<table:(table-cell|covered-table-cell)\b[^>]*>([\s\S]*?)<\/table:\1>/g;
      let c;
      while ((c = cellRe.exec(r[1]))) {
        const occurrences = /table:number-columns-repeated="(\d+)"/.exec(c[0]);
        const repeat = Math.min(occurrences ? Number(occurrences[1]) : 1, 50);
        const value = odfInnerToText(c[2]);
        for (let i = 0; i < repeat; i += 1) cells.push(value);
      }
      if (cells.some((v) => v !== '')) rows.push(cells);
    }
    if (!rows.length) {
      warnings.push(`Worksheet "${sheetName}" is empty.`);
      continue;
    }
    const header = (rows[0] || []).map((h, i) => h || `column_${i + 1}`);
    const body = rows.slice(1);
    blocks.push(
      block('table', `Worksheet: ${sheetName}\nColumns: ${header.join(' | ')}\nData rows: ${body.length}`, {
        location: { sheet: sheetName, label: `sheet "${sheetName}" overview` },
        header,
      }),
    );
    const GROUP = 20;
    for (let i = 0; i < body.length; i += GROUP) {
      const slice = body.slice(i, i + GROUP);
      const lines = [`Worksheet: ${sheetName}`, header.join(' | '), header.map(() => '---').join(' | ')];
      for (const row of slice) lines.push(header.map((_, idx) => String(row[idx] ?? '')).join(' | '));
      blocks.push(
        block('table', lines.join('\n'), {
          location: { sheet: sheetName, rowRange: [i + 2, i + slice.length + 1], label: `sheet "${sheetName}" rows ${i + 2}-${i + slice.length + 1}` },
          header,
        }),
      );
    }
  }

  return { parser: 'ods', blocks, metadata: { title, sheetNames }, warnings, ocrLikely: false };
}

/** ODP: slide text per draw:page. */
async function parseOdp(buffer, ctx = {}) {
  const { contentXml, title } = await loadContentXml(buffer, ctx.filename);
  const blocks = [];
  const pageRe = /<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g;
  let p;
  let index = 0;
  while ((p = pageRe.exec(contentXml))) {
    index += 1;
    const inner = p[1];
    const texts = [];
    const paraRe = /<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g;
    let q;
    while ((q = paraRe.exec(inner))) {
      const text = odfInnerToText(q[1]);
      if (text) texts.push(text);
    }
    if (!texts.length) continue;
    blocks.push(block('heading', texts[0].slice(0, 200), { level: 1, location: { slide: index } }));
    if (texts.length > 1) blocks.push(block('paragraph', texts.slice(1).join('\n'), { location: { slide: index } }));
  }
  return {
    parser: 'odp',
    blocks,
    metadata: { title, slideCount: index },
    warnings: blocks.length ? [] : ['No slide text was found in the presentation.'],
    ocrLikely: false,
  };
}

module.exports = { parseOdt, parseOds, parseOdp, odfInnerToText };
