'use strict';

/**
 * Stage 4: the knowledge base in the browser.
 *
 * Everything the Documents page offers besides a file upload is exercised
 * here: a web link is added and crawled into a document, the document is
 * shared as a Markdown file, and link lists and collections are created.
 *
 * The crawled page is served by a tiny local HTTP server so the suite stays
 * completely offline.
 */

const http = require('node:http');
const { test, expect } = require('@playwright/test');
const { createProject, uploadAndIndex } = require('./helpers');

/** A local page the crawler fetches exactly like a public documentation page. */
function startFixtureServer() {
  const html =
    '<html><head><title>Fixture Page</title></head><body>' +
    '<h1>Fixture Page</h1>' +
    '<p>The deployment window is <strong>Sunday 02:00 UTC</strong>.</p>' +
    '<ul><li>First bullet</li><li>Second bullet</li></ul>' +
    '</body></html>';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

test.describe.configure({ mode: 'serial' });

let fixture;
let project;

/** Opens the app on the project of this spec and switches to Documents. */
async function openDocuments(page) {
  await page.goto('/');
  await page.locator('aside select').selectOption({ label: project.name });
  await page.getByRole('button', { name: 'Documents' }).click();
  await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
}

test.beforeAll(async () => {
  fixture = await startFixtureServer();
  project = await createProject(`Knowledge ${Date.now()}`);
});

test.afterAll(async () => {
  if (fixture) await new Promise((resolve) => fixture.server.close(resolve));
});

test('adds a web link, crawls it and lists the crawled page as a document', async ({ page }) => {
  test.setTimeout(240_000);

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await openDocuments(page);

  // The Documents page opens on "Upload documents", which holds the whole
  // knowledge base.
  await expect(page.getByRole('tab', { name: 'Upload documents' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  const links = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Web links' }) });
  await links.getByPlaceholder('https://example.com/docs').fill(`${fixture.origin}/page`);
  await links.getByRole('button', { name: 'Add & crawl' }).click();

  // The link is listed straight away and the crawl is recorded.
  const row = links.getByRole('row').filter({ hasText: fixture.origin });
  await expect(row).toBeVisible();
  await expect(
    page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Crawl jobs' }) })
      .getByRole('row')
      .filter({ hasText: fixture.origin }),
  ).toBeVisible();

  // ... and ends up indexed.
  await expect(links.getByText('indexed', { exact: true }).first()).toBeVisible({
    timeout: 120_000,
  });

  // The crawled page is a normal document of the project.
  await page.getByRole('tab', { name: 'View documents' }).click();
  await expect(page.locator('table').getByText('Fixture Page', { exact: true })).toBeVisible({
    timeout: 60_000,
  });

  expect(pageErrors, 'no uncaught page errors').toEqual([]);
});

test('shares a document as a markdown file that can be viewed and downloaded', async ({ page }) => {
  test.setTimeout(240_000);

  await openDocuments(page);
  await page.getByRole('tab', { name: 'View documents' }).click();

  const row = page.locator('table tbody tr').filter({ hasText: 'Fixture Page' });
  await expect(row).toBeVisible({ timeout: 60_000 });

  // The shared file is previewed in the app.
  await row.getByRole('button', { name: 'View .md' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('The deployment window is')).toBeVisible();
  await expect(dialog.getByRole('link', { name: /Download \.md/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // ... and the download icon saves it as a Markdown file.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    row.getByTitle('Download the shared Markdown file').click(),
  ]);
  expect(download.suggestedFilename()).toBe('Fixture-Page.md');
});

test('an uploaded HTML file is parsed and shared as markdown', async ({ page }) => {
  test.setTimeout(240_000);

  // Container-based markup: no <p> tags at all, which used to index nothing.
  await uploadAndIndex(
    project.id,
    'release-notes.html',
    '<!doctype html><html><head><title>Platform Release Notes</title></head><body>' +
      '<div class="shell"><div class="content">' +
      '<div class="lead">Version 2.0 adds support for SSO.</div>' +
      '<ul><li>Faster indexing</li></ul>' +
      '</div></div></body></html>',
    { type: 'text/html' },
  );

  await openDocuments(page);
  await page.getByRole('tab', { name: 'View documents' }).click();

  const row = page.locator('table tbody tr').filter({ hasText: 'release-notes' });
  await expect(row).toBeVisible({ timeout: 60_000 });

  await row.getByRole('button', { name: 'View .md' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Version 2.0 adds support for SSO.')).toBeVisible();
  await expect(dialog.getByText('Faster indexing')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('creates link lists and collections from the knowledge base', async ({ page }) => {
  await openDocuments(page);

  // --- a link list ---------------------------------------------------------
  const lists = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Link lists' }) });
  await lists.getByPlaceholder('Public API reference').fill('Reference set');
  await lists
    .getByPlaceholder('https://example.com/a')
    .fill(`${fixture.origin}/a\n${fixture.origin}/b`);
  await lists.getByRole('button', { name: 'Create list' }).click();
  await expect(lists.getByText('Reference set')).toBeVisible();

  // --- a collection --------------------------------------------------------
  const collections = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Collections' }) });
  await collections.getByPlaceholder('Release notes').fill('Release notes');
  await collections.getByRole('button', { name: 'Create collection' }).click();
  await expect(collections.getByText('Release notes')).toBeVisible();
});
