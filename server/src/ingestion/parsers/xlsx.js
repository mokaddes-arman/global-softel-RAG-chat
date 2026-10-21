'use strict';

const XLSX = require('xlsx');
const { block } = require('./util');

const MAX_SHEETS = 50;
const MAX_ROWS_PER_SHEET = 20000;
const ROWS_PER_CHUNK = 20;

function cellToString(cell) {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  return String(cell).replace(/\s+/g, ' ').trim();
}

/**
 * XLSX/XLS via SheetJS.
 *
 * Each worksheet is preserved by name. Rows are grouped (with the header row
 * repeated in every group) so a retrieved chunk always carries column context.
 * Formula cells are read as their cached values.
 */
function parseXlsx(buffer, ctx = {}) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellFormula: false, dense: false });
  } catch (err) {
    const msg = String(err?.message || err);
    if (/password|encrypt/i.test(msg)) {
      const e = new Error(`"${ctx.filename}" is password-protected and cannot be read.`);
      e.code = 'encrypted_document';
      throw e;
    }
    const e = new Error(`Could not read spreadsheet "${ctx.filename}": ${msg}`);
    e.code = 'parse_failed';
    throw e;
  }

  const sheetNames = workbook.SheetNames || [];
  const warnings = [];
  if (sheetNames.length > MAX_SHEETS) {
    warnings.push(`Only the first ${MAX_SHEETS} of ${sheetNames.length} worksheets were indexed.`);
  }

  const blocks = [];
  const sheetSummaries = [];

  for (const name of sheetNames.slice(0, MAX_SHEETS)) {
    const worksheet = workbook.Sheets[name];
    if (!worksheet) continue;

    let rows;
    try {
      rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, blankrows: false, defval: '', raw: false });
    } catch (err) {
      warnings.push(`Worksheet "${name}" could not be read: ${err.message}`);
      continue;
    }
    if (!rows.length) {
      warnings.push(`Worksheet "${name}" is empty.`);
      continue;
    }

    const header = (rows[0] || []).map((h, i) => cellToString(h) || `column_${i + 1}`);
    const body = rows.slice(1).filter((r) => r.some((c) => cellToString(c) !== ''));
    const truncated = body.length > MAX_ROWS_PER_SHEET;
    const limited = truncated ? body.slice(0, MAX_ROWS_PER_SHEET) : body;
    if (truncated) warnings.push(`Worksheet "${name}": only the first ${MAX_ROWS_PER_SHEET} rows were indexed.`);

    sheetSummaries.push({ name, header, rows: limited.length });

    // Sheet intro chunk: name + column headers, so sheet-level questions match.
    blocks.push(
      block(
        'table',
        `Worksheet: ${name}\nColumns: ${header.join(' | ')}\nData rows: ${limited.length}`,
        { location: { sheet: name, label: `sheet "${name}" overview` }, header, kindHint: 'overview' },
      ),
    );

    if (!limited.length) continue;

    for (let i = 0; i < limited.length; i += ROWS_PER_CHUNK) {
      const slice = limited.slice(i, i + ROWS_PER_CHUNK);
      const lines = [`Worksheet: ${name}`, header.join(' | '), header.map(() => '---').join(' | ')];
      for (const row of slice) {
        const cells = header.map((_, idx) => cellToString(row[idx]));
        // Skip rows that are entirely empty after normalisation.
        if (cells.every((c) => c === '')) continue;
        lines.push(cells.join(' | '));
      }
      if (lines.length <= 3) continue;
      blocks.push(
        block('table', lines.join('\n'), {
          location: { sheet: name, rowRange: [i + 2, i + slice.length + 1], label: `sheet "${name}" rows ${i + 2}-${i + slice.length + 1}` },
          header,
        }),
      );
    }
  }

  return {
    parser: 'xlsx',
    blocks,
    metadata: {
      sheetCount: sheetNames.length,
      sheets: sheetSummaries.map((s) => ({ name: s.name, rows: s.rows, columns: s.header.length })),
      sheetNames,
    },
    warnings,
    ocrLikely: false,
  };
}

module.exports = { parseXlsx };
