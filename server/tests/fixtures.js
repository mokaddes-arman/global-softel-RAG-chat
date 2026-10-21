'use strict';

/**
 * Synthetic fixture generators. Tests build real files (a genuine minimal PDF
 * with a correct xref table, real OOXML/ODF zip containers, a real XLSX) so the
 * parsers are exercised through their actual libraries rather than mocks.
 */
const JSZip = require('jszip');
const XLSX = require('xlsx');

/** Build a valid single-page PDF with correct byte offsets. */
function minimalPdf(text = 'Hello PDF requirements document.') {
  const objects = [];
  const contentStream = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
  objects[4] = `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`;
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 6\n';
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= 5; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R /Info << /Title (Fixture PDF) >> >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Build a minimal but structurally valid .docx that mammoth can read. */
async function minimalDocx({ title = 'Fixture Heading', body = 'Fixture body paragraph.' } = {}) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${title}</w:t></w:r></w:p>
    <w:p><w:r><w:t>${body}</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Field</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Type</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>userId</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>uuid</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>`,
  );
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
</w:styles>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Minimal .pptx container - the parser reads ppt/slides/slideN.xml. */
async function minimalPptx() {
  const zip = new JSZip();
  const slide = (paras) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>${paras
    .map(
      (t) =>
        `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`,
    )
    .join('')}</p:spTree></p:cSld>
</p:sld>`;
  zip.file('ppt/slides/slide1.xml', slide(['Release Notes 4.2', 'Added IXPF export endpoint']));
  zip.file('ppt/slides/slide2.xml', slide(['Known Issues', 'Login timeout on slow networks']));
  zip.file('ppt/notesSlides/notesSlide1.xml', slide(['Speaker notes for slide one']));
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Minimal .odt container with heading + paragraph. */
async function minimalOdt({ title = 'ODT Heading', paragraph = 'ODT paragraph text.' } = {}) {
  const zip = new JSZip();
  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
  <office:body><office:text>
    <text:h text:outline-level="1">${title}</text:h>
    <text:p>${paragraph}</text:p>
  </office:text></office:body>
</office:document-content>`,
  );
  zip.file(
    'meta.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <office:meta><dc:title>Fixture ODT</dc:title></office:meta>
</office:document-meta>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Minimal .ods with one named worksheet. */
async function minimalOds() {
  const zip = new JSZip();
  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
  <office:body><office:spreadsheet>
    <table:table table:name="Requirements">
      <table:table-row><table:table-cell><text:p>ID</text:p></table:table-cell><table:table-cell><text:p>Requirement</text:p></table:table-cell></table:table-row>
      <table:table-row><table:table-cell><text:p>REQ-1</text:p></table:table-cell><table:table-cell><text:p>Users can log in with SSO</text:p></table:table-cell></table:table-row>
    </table:table>
  </office:spreadsheet></office:body>
</office:document-content>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Real XLSX with two worksheets (header + rows). */
function minimalXlsx() {
  const wb = XLSX.utils.book_new();
  const reqSheet = XLSX.utils.aoa_to_sheet([
    ['ID', 'Requirement', 'Priority'],
    ['REQ-1', 'Users can log in with SSO', 'High'],
    ['REQ-2', 'Export audit log as CSV', 'Medium'],
  ]);
  const apiSheet = XLSX.utils.aoa_to_sheet([
    ['Endpoint', 'Method', 'Auth'],
    ['/api/v1/projects', 'GET', 'Bearer'],
    ['/api/v1/documents', 'POST', 'Bearer'],
  ]);
  XLSX.utils.book_append_sheet(wb, reqSheet, 'Requirements');
  XLSX.utils.book_append_sheet(wb, apiSheet, 'API');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { minimalPdf, minimalDocx, minimalPptx, minimalOdt, minimalOds, minimalXlsx };
