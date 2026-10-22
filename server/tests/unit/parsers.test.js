'use strict';

/* globals describe, it, expect */
const registry = require('../../src/ingestion/parsers');
const text = require('../../src/ingestion/parsers/text');
const csv = require('../../src/ingestion/parsers/csv');
const json = require('../../src/ingestion/parsers/json');
const yaml = require('../../src/ingestion/parsers/yaml');
const html = require('../../src/ingestion/parsers/html');
const xml = require('../../src/ingestion/parsers/xml');
const rtf = require('../../src/ingestion/parsers/rtf');
const pdf = require('../../src/ingestion/parsers/pdf');
const docx = require('../../src/ingestion/parsers/docx');
const xlsx = require('../../src/ingestion/parsers/xlsx');
const pptx = require('../../src/ingestion/parsers/pptx');
const odf = require('../../src/ingestion/parsers/opendocument');
const fixtures = require('../fixtures');

const B = (s) => Buffer.from(s, 'utf8');

describe('parser registry', () => {
  it('resolves common documentation formats', () => {
    for (const ext of ['pdf', 'docx', 'xlsx', 'xls', 'pptx', 'txt', 'md', 'csv', 'json', 'yaml', 'html', 'xml', 'rtf', 'odt', 'ods', 'odp', 'log', 'sql']) {
      expect(registry.isSupported(ext), `${ext} should be supported`).toBe(true);
    }
  });

  it('reports a helpful reason for known-unsupported formats', () => {
    expect(registry.isSupported('doc')).toBe(false);
    expect(registry.unsupportedReason('doc')).toMatch(/re-save the file as \.docx/i);
    expect(registry.unsupportedReason('xyz')).toMatch(/not supported/i);
  });
});

describe('text parsers', () => {
  it('splits plain text into paragraphs and tracks form-feed pages', () => {
    const parsed = text.parsePlainText(B('First paragraph.\n\nSecond paragraph.\fPage two text.'));
    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks[2].location.page).toBe(2);
  });

  it('detects binary content mislabelled as text', () => {
    const binary = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64, 0)]);
    expect(() => text.parsePlainText(binary, { filename: 'fake.txt' })).toThrow(/does not look like UTF-8 text/i);
  });

  it('extracts markdown headings, sections and fenced code', () => {
    const parsed = text.parseMarkdown(B('# Title\n\nIntro text.\n\n## Section A\n\nBody A.\n\n```js\nconst x = 1;\n```\n'));
    const kinds = parsed.blocks.map((b) => b.kind);
    expect(kinds).toContain('heading');
    expect(kinds).toContain('code');
    const sectionBlock = parsed.blocks.find((b) => b.text === 'Body A.');
    expect(sectionBlock.location.section).toBe('Section A');
  });

  it('groups log lines without losing content', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `2026-01-01T00:00:0${i % 10}Z INFO event ${i}`).join('\n');
    const parsed = text.parseLog(B(lines));
    expect(parsed.blocks.length).toBeGreaterThan(1);
    expect(parsed.metadata.lineCount).toBe(60);
  });
});

describe('structured data parsers', () => {
  it('keeps CSV headers in every chunk with row ranges', () => {
    const rows = ['id,name,qty', ...Array.from({ length: 60 }, (_, i) => `${i},item ${i},${i * 2}`)].join('\n');
    const parsed = csv.parseCsv(B(rows), { extension: 'csv', filename: 'stock.csv' });
    expect(parsed.blocks.length).toBeGreaterThan(1);
    for (const b of parsed.blocks) {
      expect(b.text).toContain('id | name | qty');
      expect(b.location.sheet).toBe('stock.csv');
    }
    expect(parsed.metadata.rows).toBe(60);
  });

  it('reports invalid CSV instead of silently succeeding', () => {
    expect(() => csv.parseCsv(B('a,b\n"unterminated'), { extension: 'csv', filename: 'bad.csv' })).toThrow(/could not parse csv/i);
  });

  it('flattens JSON into readable key paths', () => {
    const parsed = json.parseJson(B(JSON.stringify({ api: { base: '/v1', auth: 'bearer' }, tags: ['a', 'b'] })), { filename: 'cfg.json' });
    const all = parsed.blocks.map((b) => b.text).join('\n');
    expect(all).toContain('api.base: /v1');
    expect(all).toContain('tags: a, b');
  });

  it('rejects invalid JSON with a clear error', () => {
    expect(() => json.parseJson(B('{ not json'), { filename: 'x.json' })).toThrow(/invalid json/i);
  });

  it('flattens YAML documents', () => {
    const parsed = yaml.parseYaml(B('service:\n  name: ixpf\n  port: 8080\n'), { filename: 'svc.yaml' });
    expect(parsed.blocks.map((b) => b.text).join('\n')).toContain('service.port: 8080');
  });

  it('extracts HTML headings, sections and tables', () => {
    const parsed = html.parseHtml(
      B('<html><head><title>Guide</title></head><body><h1>Setup</h1><p>Install it.</p><h2>Config</h2><table><tr><th>Key</th><th>Value</th></tr><tr><td>port</td><td>3000</td></tr></table></body></html>'),
    );
    expect(parsed.blocks.some((b) => b.kind === 'heading' && b.text === 'Config')).toBe(true);
    const table = parsed.blocks.find((b) => b.kind === 'table');
    expect(table.text).toContain('Key | Value');
    expect(table.text).toContain('port | 3000');
  });

  it('extracts HTML whose text lives in divs instead of paragraphs', () => {
    const parsed = html.parseHtml(
      B('<html><head><title>Release Notes</title></head><body><div class="layout"><div class="content"><div class="headline">Release Notes</div><div class="body">Version 2.0 adds support for SSO.</div><ul><li>Faster indexing</li><li>Safer crawls</li></ul></div></div></body></html>'),
    );
    const all = parsed.blocks.map((b) => b.text).join('\n');
    expect(parsed.metadata.title).toBe('Release Notes');
    expect(all).toContain('Version 2.0 adds support for SSO.');
    expect(all).toContain('Faster indexing');
    expect(parsed.blocks.some((b) => b.kind === 'list' && b.text === 'Safer crawls')).toBe(true);
  });

  it('decodes HTML according to its declared charset', () => {
    const buffer = Buffer.from(
      '<html><head><meta charset="windows-1252"><title>Pricing</title></head><body><p>Price \x80 5</p></body></html>',
      'latin1',
    );
    const parsed = html.parseHtml(buffer);
    expect(parsed.blocks.map((b) => b.text).join(' ')).toContain('€');
  });

  it('decodes UTF-16 HTML files', () => {
    const text = '<html><body><div>Unicode ✓ content</div></body></html>';
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const parsed = html.parseHtml(buffer);
    expect(parsed.blocks.map((b) => b.text).join(' ')).toContain('Unicode ✓ content');
  });

  it('flattens XML element paths', () => {
    const parsed = xml.parseXml(B('<config><db host="localhost" port="5432"/><mode>prod</mode></config>'), { filename: 'c.xml' });
    const all = parsed.blocks.map((b) => b.text).join('\n');
    expect(all).toContain('config.db.@host: localhost');
    expect(all).toContain('config.mode: prod');
  });

  it('strips RTF control words but keeps text', () => {
    const parsed = rtf.parseRtf(B('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs20 Hello\\par Requirements\\par}'));
    const all = parsed.blocks.map((b) => b.text).join('\n');
    expect(all).toContain('Hello');
    expect(all).toContain('Requirements');
    expect(all).not.toContain('fonttbl');
  });
});

describe('binary document parsers', () => {
  it('extracts PDF text with page numbers', async () => {
    const parsed = await pdf.parsePdf(fixtures.minimalPdf('REQ-77 export is disabled'), { filename: 'doc.pdf' });
    expect(parsed.metadata.pageCount).toBe(1);
    expect(parsed.ocrLikely).toBe(false);
    expect(parsed.blocks.map((b) => b.text).join(' ')).toContain('REQ-77');
    expect(parsed.blocks[0].location.page).toBe(1);
  });

  it('parses DOCX headings and tables', async () => {
    const buffer = await fixtures.minimalDocx({ title: 'Project Charter', body: 'Scope statement.' });
    const parsed = await docx.parseDocx(buffer, { filename: 'charter.docx' });
    const headings = parsed.blocks.filter((b) => b.kind === 'heading').map((b) => b.text);
    const tables = parsed.blocks.filter((b) => b.kind === 'table').map((b) => b.text);
    expect(headings.join(' ')).toContain('Project Charter');
    expect(tables.join(' ')).toContain('userId');
  });

  it('parses XLSX worksheets with names, headers and row groups', () => {
    const parsed = xlsx.parseXlsx(fixtures.minimalXlsx(), { filename: 'spec.xlsx' });
    expect(parsed.metadata.sheetNames).toEqual(['Requirements', 'API']);
    const allSheets = parsed.blocks.map((b) => b.location.sheet);
    expect(allSheets).toContain('Requirements');
    expect(allSheets).toContain('API');
    const reqChunk = parsed.blocks.find((b) => b.text.includes('REQ-1'));
    expect(reqChunk.text).toContain('ID | Requirement | Priority');
    expect(reqChunk.location.rowRange).toBeTruthy();
  });

  it('parses PPTX slides and speaker notes with slide numbers', async () => {
    const parsed = await pptx.parsePptx(await fixtures.minimalPptx(), { filename: 'deck.pptx' });
    expect(parsed.metadata.slideCount).toBe(2);
    expect(parsed.blocks.map((b) => b.text).join(' ')).toContain('Release Notes 4.2');
    expect(parsed.blocks.map((b) => b.text).join(' ')).toContain('Speaker notes');
    expect(parsed.blocks.some((b) => b.location.slide === 2)).toBe(true);
  });

  it('parses ODT and ODS', async () => {
    const odt = await odf.parseOdt(await fixtures.minimalOdt({ title: 'ODT Heading', paragraph: 'ODT paragraph text.' }), { filename: 'a.odt' });
    expect(odt.blocks.some((b) => b.kind === 'heading' && b.text === 'ODT Heading')).toBe(true);
    const ods = await odf.parseOds(await fixtures.minimalOds(), { filename: 'a.ods' });
    expect(ods.metadata.sheetNames).toContain('Requirements');
    expect(ods.blocks.map((b) => b.text).join(' ')).toContain('Users can log in with SSO');
  });
});
