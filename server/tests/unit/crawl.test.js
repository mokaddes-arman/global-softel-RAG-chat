/* globals describe, it, expect */
const { htmlToMarkdown } = require('../../src/crawl/markdown');
const { parseUrl, canonicalUrl, isPrivateAddress } = require('../../src/crawl/fetcher');

describe('crawl: html to markdown', () => {
  it('keeps headings, paragraphs and emphasis', () => {
    const { title, markdown } = htmlToMarkdown(
      '<html><head><title>Doc</title></head><body><h1>Title</h1><p>Hello <strong>world</strong>.</p></body></html>',
    );
    expect(title).toBe('Doc');
    expect(markdown).toContain('# Title');
    expect(markdown).toContain('**world**');
  });

  it('converts lists, tables, code and links', () => {
    const { markdown } = htmlToMarkdown(
      '<body><ul><li>one</li><li>two</li></ul>' +
        '<ol><li>first</li><li>second</li></ol>' +
        '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>' +
        '<pre><code class="language-js">const a = 1;</code></pre>' +
        '<p><a href="/docs">Docs</a></p></body>',
    );
    expect(markdown).toContain('- one');
    expect(markdown).toContain('1. first');
    expect(markdown).toContain('| A | B |');
    expect(markdown).toContain('```js');
    expect(markdown).toContain('[Docs](/docs)');
  });

  it('drops scripts and styles', () => {
    const { markdown } = htmlToMarkdown(
      '<body><script>var x = 1;</script><style>.a{color:red}</style><p>Keep me</p></body>',
    );
    expect(markdown).toContain('Keep me');
    expect(markdown).not.toContain('var x');
    expect(markdown).not.toContain('color:red');
  });

  it('never returns an empty document for a page with a title', () => {
    const { markdown } = htmlToMarkdown('<html><head><title>Only a title</title></head><body></body></html>');
    expect(markdown).toContain('# Only a title');
  });
});

describe('crawl: url safety', () => {
  it('accepts http and https and assumes https for a bare host', () => {
    expect(parseUrl('https://example.com/a').protocol).toBe('https:');
    expect(parseUrl('example.com/a').protocol).toBe('https:');
    expect(parseUrl('http://example.com/a').protocol).toBe('http:');
  });

  it('refuses other protocols and embedded credentials', () => {
    expect(() => parseUrl('ftp://example.com/file')).toThrow(/http/i);
    expect(() => parseUrl('file:///etc/passwd')).toThrow(/http/i);
    expect(() => parseUrl('https://user:pass@example.com/')).toThrow(/credentials/i);
  });

  it('canonicalises the same link written in different ways', () => {
    expect(canonicalUrl('https://www.example.com/docs/')).toBe('https://example.com/docs');
    expect(canonicalUrl('https://example.com/docs#anchor')).toBe('https://example.com/docs');
    expect(canonicalUrl('https://example.com/docs')).toBe(canonicalUrl('https://www.example.com/docs/'));
  });

  it('recognises private and loopback addresses', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('192.168.0.1')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });
});
