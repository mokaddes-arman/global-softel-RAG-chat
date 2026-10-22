'use strict';

/**
 * Stage 3: the same workflow a person drives by hand —
 * create a project -> upload a document -> wait for indexing -> ask a question
 * -> read the grounded answer and its citations — executed entirely in the
 * browser against the real backend.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const {
  SAMPLE_DOCUMENT,
  SAMPLE_QUESTION,
  createProject,
  createConversation,
  uploadAndIndex,
  ask,
} = require('./helpers');

/** Write the sample document to a temp file so `setInputFiles` can use it. */
function writeSampleDocument() {
  const file = path.join(os.tmpdir(), `global-softel-e2e-${Date.now()}.md`);
  fs.writeFileSync(file, SAMPLE_DOCUMENT, 'utf8');
  return file;
}

const GROUNDED_ANSWER = /\[mock\] I found \d+ evidence block/;

test('project persona/instructions persist through the dashboard editor', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const projectName = `UI Persona ${Date.now()}`;
  await page.goto('/');

  // --- create a project -----------------------------------------------------
  await page.locator('aside').getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('e.g. Platform API Specification').fill(projectName);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog).toBeHidden();

  // --- dashboard > edit > load the SQA persona > save -----------------------
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await page.getByRole('button', { name: 'Edit' }).click();

  const editDialog = page.getByRole('dialog');
  await expect(editDialog).toBeVisible();
  const instructions = editDialog.getByPlaceholder(/Senior SQA Engineer/);
  await expect(instructions).toHaveValue('');

  await editDialog.getByRole('button', { name: /Load Senior SQA Engineer persona template/ }).click();
  await expect(instructions).toHaveValue(/Senior SQA Engineer/);

  await editDialog.getByRole('button', { name: 'Save' }).click();
  await expect(editDialog).toBeHidden();

  // --- the value survives a full reload ------------------------------------
  await page.reload();
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  const reopened = page.getByRole('dialog');
  await expect(reopened.getByPlaceholder(/Senior SQA Engineer/)).toHaveValue(/Senior SQA Engineer/);

  expect(pageErrors, 'no uncaught page errors').toEqual([]);
});

test('upload a document, ask a question and read the cited answer', async ({ page }) => {
  test.setTimeout(240_000);

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const projectName = `UI Workflow ${Date.now()}`;
  await page.goto('/');

  // --- 1. create a project -------------------------------------------------
  // `exact` keeps this from also matching the sidebar's "New conversation" button.
  await page.locator('aside').getByRole('button', { name: 'New', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('e.g. Platform API Specification').fill(projectName);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible();

  // --- 2. upload a document -------------------------------------------------
  // The Documents page has two sections: "Upload documents" (files + the rest
  // of the knowledge base) and "View documents" (the document table).
  await page.getByRole('button', { name: 'Documents' }).click();
  await page.getByRole('tab', { name: 'View documents' }).click();
  await expect(page.getByText('No documents yet')).toBeVisible();

  await page.getByRole('tab', { name: 'Upload documents' }).click();
  await page.locator('input[type="file"]').first().setInputFiles(writeSampleDocument());

  await expect(page.getByText(/queued for indexing/)).toBeVisible();

  await page.getByRole('tab', { name: 'View documents' }).click();
  await expect(page.locator('table').getByText('indexed', { exact: true })).toBeVisible({
    timeout: 120_000,
  });

  // --- 3. ask a grounded question ------------------------------------------
  await page.getByRole('button', { name: 'Chat' }).click();
  const composer = page.getByPlaceholder(/Ask a question/);
  await expect(composer).toBeEnabled();
  await composer.fill(SAMPLE_QUESTION);
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText(GROUNDED_ANSWER).first()).toBeVisible({ timeout: 120_000 });

  // --- 4. the answer exposes its citations ---------------------------------
  const sourcesToggle = page.getByRole('button', { name: /Show \d+ source/ }).first();
  await expect(sourcesToggle).toBeVisible();
  await sourcesToggle.click();

  const excerptButton = page.getByRole('button', { name: 'Show excerpt' }).first();
  await expect(excerptButton).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy citation' }).first()).toBeVisible();

  // --- 5. the exchange survives a reload -----------------------------------
  await page.reload();
  const conversation = page
    .locator('aside')
    .getByRole('button')
    .filter({ hasText: 'rate limit per minute' })
    .first();
  await conversation.click();

  await expect(page.getByText(GROUNDED_ANSWER).first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /Show \d+ source/ }).first().click();
  await expect(page.getByRole('button', { name: 'Show excerpt' }).first()).toBeVisible();

  expect(pageErrors, 'no uncaught page errors').toEqual([]);
});

test('the model usage page reports per-model token usage', async ({ page }) => {
  test.setTimeout(120_000);

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // Seed usage through the real API: the mock provider records a completed
  // answer, so one model has non-zero requests/tokens.
  const project = await createProject(`Usage ${Date.now()}`);
  const conversation = await createConversation(project.id);
  await uploadAndIndex(project.id, 'usage.md', SAMPLE_DOCUMENT);
  await ask(conversation.id, SAMPLE_QUESTION);

  await page.goto('/');
  await page.getByRole('button', { name: 'Model usage' }).click();

  await expect(page.getByRole('heading', { name: 'Model usage' })).toBeVisible();
  // Summary + range filters are present.
  await expect(page.getByText('Total tokens').first()).toBeVisible();
  await expect(page.getByText('Group by')).toBeVisible();

  // The model that answered is listed with usage, and a totals row is shown.
  const table = page.getByRole('table');
  await expect(table).toBeVisible();
  // "mock" appears in both the model and provider columns, so scope to the first.
  await expect(table.getByRole('cell', { name: 'mock', exact: true }).first()).toBeVisible();
  // The totals footer row starts with "Total"; anchor it so the header ("Total tokens") doesn't match.
  await expect(table.getByRole('row', { name: /^Total/ })).toBeVisible();

  expect(pageErrors, 'no uncaught page errors').toEqual([]);
});
