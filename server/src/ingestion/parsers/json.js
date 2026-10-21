'use strict';

const { block } = require('./util');
const { normaliseText } = require('./text');

function flatten(value, prefix = '', out = [], depth = 0) {
  if (depth > 6 || out.length > 5000) return out;
  if (value === null || typeof value !== 'object') {
    out.push(`${prefix}: ${formatScalar(value)}`);
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${prefix}: []`);
      return out;
    }
    // Arrays of scalars are kept together; arrays of objects are indexed by position.
    const scalarOnly = value.every((v) => v === null || typeof v !== 'object');
    if (scalarOnly) {
      out.push(`${prefix}: ${value.map(formatScalar).join(', ')}`);
      return out;
    }
    value.slice(0, 200).forEach((v, i) => flatten(v, `${prefix}[${i}]`, out, depth + 1));
    if (value.length > 200) out.push(`${prefix}: ... ${value.length - 200} more items omitted`);
    return out;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    out.push(`${prefix}: {}`);
    return out;
  }
  for (const key of keys) {
    flatten(value[key], prefix ? `${prefix}.${key}` : key, out, depth + 1);
  }
  return out;
}

function formatScalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();
  return String(v);
}

function parseJson(buffer, ctx = {}) {
  const raw = normaliseText(buffer);
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const e = new Error(`Invalid JSON in "${ctx.filename}": ${err.message}`);
    e.code = 'parse_failed';
    throw e;
  }
  const lines = flatten(data, '', []);
  const blocks = [];
  const GROUP = 40;
  for (let i = 0; i < lines.length; i += GROUP) {
    const slice = lines.slice(i, i + GROUP);
    blocks.push(block('code', slice.join('\n'), { location: { label: `fields ${i + 1}-${i + slice.length}` } }));
  }
  if (!blocks.length) {
    blocks.push(block('code', JSON.stringify(data).slice(0, 4000)));
  }
  return {
    parser: 'json',
    blocks,
    metadata: { topLevelType: Array.isArray(data) ? 'array' : typeof data, fieldCount: lines.length },
    warnings: [],
    ocrLikely: false,
  };
}

function parseJsonLines(buffer, ctx = {}) {
  const raw = normaliseText(buffer);
  const lines = raw.split('\n').filter((l) => l.trim());
  const blocks = [];
  const GROUP = 20;
  for (let i = 0; i < lines.length; i += GROUP) {
    const slice = lines.slice(i, i + GROUP);
    const rendered = [];
    for (const line of slice) {
      try {
        rendered.push(flatten(JSON.parse(line), '', []).join('\n'));
      } catch {
        rendered.push(line);
      }
    }
    blocks.push(block('code', rendered.join('\n---\n'), { location: { label: `records ${i + 1}-${i + slice.length}` } }));
  }
  return {
    parser: 'jsonl',
    blocks,
    metadata: { records: lines.length },
    warnings: [],
    ocrLikely: false,
  };
}

module.exports = { parseJson, parseJsonLines, flattenJson: flatten };
