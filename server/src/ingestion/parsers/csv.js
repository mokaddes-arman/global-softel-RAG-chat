'use strict';

const { parse } = require('csv-parse/sync');
const { block, countWords } = require('./util');
const { normaliseText } = require('./text');

const MAX_ROWS = 20000; // guard against pathological files

/**
 * CSV/TSV: rows are grouped so that each chunk keeps the header row and enough
 * related rows to be meaningful, together with a row-range location.
 */
function parseCsv(buffer, ctx = {}) {
  const delimiter = ctx.extension === 'tsv' ? '\t' : undefined;
  const raw = normaliseText(buffer);

  let records;
  try {
    records = parse(raw, {
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true,
      delimiter,
      bom: true,
      trim: true,
    });
  } catch (err) {
    const e = new Error(`Could not parse CSV "${ctx.filename}": ${err.message}`);
    e.code = 'parse_failed';
    throw e;
  }

  if (!records.length) {
    return { parser: 'csv', blocks: [], metadata: { rows: 0 }, warnings: ['File contained no rows.'], ocrLikely: false };
  }

  const header = records[0].map((h) => String(h ?? '').trim());
  const rows = records.slice(1);
  const warnings = [];
  const truncated = rows.length > MAX_ROWS;
  const limited = truncated ? rows.slice(0, MAX_ROWS) : rows;
  if (truncated) warnings.push(`Only the first ${MAX_ROWS} data rows were indexed (file had ${rows.length}).`);

  const blocks = [];
  const GROUP = 25;
  for (let i = 0; i < limited.length; i += GROUP) {
    const slice = limited.slice(i, i + GROUP);
    const lines = [header.map((h, idx) => h || `column_${idx + 1}`).join(' | ')];
    lines.push(header.map(() => '---').join(' | '));
    for (const row of slice) {
      lines.push(header.map((_, idx) => String(row[idx] ?? '').replace(/\s+/g, ' ').trim()).join(' | '));
    }
    blocks.push(
      block('table', lines.join('\n'), {
        location: { sheet: ctx.filename, rowRange: [i + 2, i + slice.length + 1], label: `rows ${i + 2}-${i + slice.length + 1}` },
        header,
      }),
    );
  }

  const text = blocks.map((b) => b.text).join('\n\n');
  return {
    parser: 'csv',
    blocks,
    metadata: { rows: limited.length, columns: header.length, header, delimiter: delimiter || ',' },
    warnings,
    ocrLikely: false,
    wordCount: countWords(text),
  };
}

module.exports = { parseCsv };
