'use strict';

const { XMLParser } = require('fast-xml-parser');
const { block } = require('./util');

/**
 * Generic XML: parsed with fast-xml-parser and flattened into path: value lines
 * that preserve element names and attributes (attributes are prefixed with @).
 */
function flattenXml(node, prefix, out, depth) {
  if (out.length > 8000 || depth > 12) return out;
  if (node === null || node === undefined) return out;
  if (typeof node !== 'object') {
    out.push(`${prefix}: ${String(node).replace(/\s+/g, ' ').trim()}`);
    return out;
  }
  if (Array.isArray(node)) {
    node.slice(0, 500).forEach((child, i) => flattenXml(child, `${prefix}[${i}]`, out, depth + 1));
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === '#text') {
      out.push(`${prefix}: ${String(value).replace(/\s+/g, ' ').trim()}`);
      continue;
    }
    const next = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value) || (value && typeof value === 'object')) flattenXml(value, next, out, depth + 1);
    else out.push(`${next}: ${String(value).replace(/\s+/g, ' ').trim()}`);
  }
  return out;
}

function parseXml(buffer, ctx = {}) {
  const raw = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
    allowBooleanAttributes: true,
  });

  let data;
  try {
    data = parser.parse(raw);
  } catch (err) {
    const e = new Error(`Invalid XML in "${ctx.filename}": ${err.message}`);
    e.code = 'parse_failed';
    throw e;
  }

  const rootKeys = Object.keys(data || {});
  const rootName = rootKeys[0] || 'document';
  const lines = flattenXml(data, rootName, [], 0);

  const blocks = [];
  const GROUP = 40;
  for (let i = 0; i < lines.length; i += GROUP) {
    const slice = lines.slice(i, i + GROUP);
    blocks.push(block('code', slice.join('\n'), { location: { section: rootName, label: `nodes ${i + 1}-${i + slice.length}` } }));
  }
  if (!blocks.length) {
    blocks.push(block('code', raw.slice(0, 4000), { location: { section: rootName } }));
  }

  return {
    parser: 'xml',
    blocks,
    metadata: { rootElement: rootName, nodeCount: lines.length },
    warnings: [],
    ocrLikely: false,
  };
}

module.exports = { parseXml, flattenXml };
