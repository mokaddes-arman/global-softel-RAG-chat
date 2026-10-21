'use strict';

const JSZip = require('jszip');
const { block } = require('./util');

const isOle = (buffer) => buffer.length > 8 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/**
 * Extract `<a:t>` runs from DrawingML (PowerPoint) markup, preserving paragraph
 * and line breaks. Returns an array of paragraph strings.
 */
function extractDrawingParagraphs(xml) {
  const cleaned = xml.replace(/<\/a:p>/g, '\u0000').replace(/<a:br\s*\/>/g, '\n');
  const paragraphs = [];
  const re = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
  const segments = cleaned.split('\u0000');
  for (const seg of segments) {
    let text = '';
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(seg))) text += decodeXmlEntities(m[1]);
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (trimmed) paragraphs.push(trimmed);
  }
  return paragraphs;
}

async function parsePptx(buffer, ctx = {}) {
  if (isOle(buffer)) {
    const e = new Error(`"${ctx.filename}" appears to be an encrypted or legacy PowerPoint file and cannot be read.`);
    e.code = 'encrypted_document';
    throw e;
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    const e = new Error(`Could not open PowerPoint file "${ctx.filename}": ${err.message}`);
    e.code = 'parse_failed';
    throw e;
  }

  const slideEntries = Object.keys(zip.files)
    .map((name) => ({ name, m: /^ppt\/slides\/slide(\d+)\.xml$/.exec(name) }))
    .filter((x) => x.m)
    .map((x) => ({ name: x.name, num: Number(x.m[1]) }))
    .sort((a, b) => a.num - b.num);

  const notesEntries = Object.keys(zip.files)
    .map((name) => ({ name, m: /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(name) }))
    .filter((x) => x.m)
    .map((x) => ({ name: x.name, num: Number(x.m[1]) }));

  const blocks = [];
  const warnings = [];
  const titleBySlide = new Map();

  for (const slide of slideEntries) {
    const xml = await zip.file(slide.name).async('string');
    const paragraphs = extractDrawingParagraphs(xml);
    if (!paragraphs.length) continue;

    const title = paragraphs[0].slice(0, 200);
    titleBySlide.set(slide.num, title);
    blocks.push(block('heading', title, { level: 1, location: { slide: slide.num } }));
    const body = paragraphs.slice(1);
    if (body.length) {
      blocks.push(block('paragraph', body.join('\n'), { location: { slide: slide.num } }));
    }
  }

  for (const note of notesEntries) {
    const xml = await zip.file(note.name).async('string');
    const paragraphs = extractDrawingParagraphs(xml);
    if (!paragraphs.length) continue;
    // notesSlide numbering matches slide numbering in practice.
    blocks.push(block('note', `Speaker notes: ${paragraphs.join(' ')}`, { location: { slide: note.num } }));
  }

  if (!slideEntries.length) warnings.push('No slides with text were found in this presentation.');

  return {
    parser: 'pptx',
    blocks,
    metadata: { slideCount: slideEntries.length, titles: [...titleBySlide.values()] },
    warnings,
    ocrLikely: false,
  };
}

module.exports = { parsePptx, extractDrawingParagraphs, decodeXmlEntities, isOle };
