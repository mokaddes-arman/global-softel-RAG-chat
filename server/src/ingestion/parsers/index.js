'use strict';

/**
 * Parser registry.
 *
 * A parser is: `async (buffer, ctx) => ParsedDocument` (see util.js).
 * `ctx` = { extension, mimeType, filename, options }.
 *
 * The registry maps extensions to parsers so adding a format is a one-line
 * change. Anything not present in the map is reported as unsupported instead of
 * pretending the file was indexed.
 */
const text = require('./text');
const csv = require('./csv');
const json = require('./json');
const yaml = require('./yaml');
const html = require('./html');
const xml = require('./xml');
const rtf = require('./rtf');
const pdf = require('./pdf');
const docx = require('./docx');
const xlsx = require('./xlsx');
const pptx = require('./pptx');
const opendocument = require('./opendocument');

/** extension -> { parser, label, mimeTypes[] } */
const REGISTRY = {
  // Plain text family
  txt: { parser: text.parsePlainText, label: 'Text' },
  text: { parser: text.parsePlainText, label: 'Text' },
  log: { parser: text.parseLog, label: 'Log' },
  md: { parser: text.parseMarkdown, label: 'Markdown' },
  markdown: { parser: text.parseMarkdown, label: 'Markdown' },
  mdx: { parser: text.parseMarkdown, label: 'Markdown' },
  rst: { parser: text.parsePlainText, label: 'reStructuredText' },
  // Source code / config as plain text
  js: { parser: text.parseCode, label: 'JavaScript' },
  mjs: { parser: text.parseCode, label: 'JavaScript' },
  cjs: { parser: text.parseCode, label: 'JavaScript' },
  ts: { parser: text.parseCode, label: 'TypeScript' },
  tsx: { parser: text.parseCode, label: 'TypeScript' },
  jsx: { parser: text.parseCode, label: 'JavaScript' },
  py: { parser: text.parseCode, label: 'Python' },
  java: { parser: text.parseCode, label: 'Java' },
  cs: { parser: text.parseCode, label: 'C#' },
  go: { parser: text.parseCode, label: 'Go' },
  rb: { parser: text.parseCode, label: 'Ruby' },
  php: { parser: text.parseCode, label: 'PHP' },
  sql: { parser: text.parseCode, label: 'SQL' },
  sh: { parser: text.parseCode, label: 'Shell' },
  ps1: { parser: text.parseCode, label: 'PowerShell' },
  bat: { parser: text.parseCode, label: 'Batch' },
  cmd: { parser: text.parseCode, label: 'Batch' },
  ini: { parser: text.parsePlainText, label: 'INI' },
  cfg: { parser: text.parsePlainText, label: 'Config' },
  conf: { parser: text.parsePlainText, label: 'Config' },
  properties: { parser: text.parsePlainText, label: 'Properties' },
  env: { parser: text.parsePlainText, label: 'Env' },
  // Structured data
  csv: { parser: csv.parseCsv, label: 'CSV' },
  tsv: { parser: csv.parseCsv, label: 'TSV' },
  json: { parser: json.parseJson, label: 'JSON' },
  jsonl: { parser: json.parseJsonLines, label: 'JSON Lines' },
  ndjson: { parser: json.parseJsonLines, label: 'JSON Lines' },
  yaml: { parser: yaml.parseYaml, label: 'YAML' },
  yml: { parser: yaml.parseYaml, label: 'YAML' },
  xml: { parser: xml.parseXml, label: 'XML' },
  html: { parser: html.parseHtml, label: 'HTML' },
  htm: { parser: html.parseHtml, label: 'HTML' },
  xhtml: { parser: html.parseHtml, label: 'HTML' },
  // Rich documents
  pdf: { parser: pdf.parsePdf, label: 'PDF' },
  docx: { parser: docx.parseDocx, label: 'Word (DOCX)' },
  xlsx: { parser: xlsx.parseXlsx, label: 'Excel (XLSX)' },
  xls: { parser: xlsx.parseXlsx, label: 'Excel (XLS)' },
  pptx: { parser: pptx.parsePptx, label: 'PowerPoint (PPTX)' },
  rtf: { parser: rtf.parseRtf, label: 'RTF' },
  odt: { parser: opendocument.parseOdt, label: 'OpenDocument Text' },
  ods: { parser: opendocument.parseOds, label: 'OpenDocument Spreadsheet' },
  odp: { parser: opendocument.parseOdp, label: 'OpenDocument Presentation' },
};

/**
 * Formats we knowingly cannot parse yet. We surface an actionable message
 * instead of silently failing or pretending success.
 */
const KNOWN_UNSUPPORTED = {
  doc: 'Legacy binary Word (.doc) is not supported. Re-save the file as .docx or export to PDF and upload again.',
  ppt: 'Legacy binary PowerPoint (.ppt) is not supported. Re-save the file as .pptx or export to PDF and upload again.',
  msg: 'Outlook message (.msg) is not supported. Export the content to PDF or text and upload again.',
  eml: 'Email files (.eml) are not supported. Export the content to PDF or text and upload again.',
  pages: 'Apple Pages documents are not supported. Export to PDF or DOCX and upload again.',
  numbers: 'Apple Numbers spreadsheets are not supported. Export to XLSX or CSV and upload again.',
  key: 'Apple Keynote documents are not supported. Export to PDF or PPTX and upload again.',
};

function getParser(ext) {
  return REGISTRY[String(ext || '').toLowerCase()] || null;
}

function isSupported(ext) {
  return Boolean(getParser(ext));
}

function unsupportedReason(ext) {
  const e = String(ext || '').toLowerCase();
  return KNOWN_UNSUPPORTED[e] || `Files with extension ".${e || '?'}" are not supported.`;
}

function supportedExtensions() {
  return Object.keys(REGISTRY).sort();
}

function labelFor(ext) {
  return getParser(ext)?.label || 'Unknown';
}

module.exports = {
  getParser,
  isSupported,
  unsupportedReason,
  supportedExtensions,
  labelFor,
  KNOWN_UNSUPPORTED,
  REGISTRY,
};
