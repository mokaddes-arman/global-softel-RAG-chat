'use strict';

/**
 * Stage 1 of the e2e run: the API is alive, the SPA shell renders, and a
 * project can be created through the interface.
 *
 * This file is named `01-*` on purpose: it is the only spec that relies on the
 * database being empty, so it must run first (`workers: 1` + sorted filenames).
 * It also degrades gracefully if it is ever run in isolation against data.
 */

const { test, expect } = require('@playwright/test');

/** Console noise that is not a defect in the application. */
function isBenignConsoleError(text) {
  return /favicon\.ico/i.test(text);
}

test('API health endpoint answers', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.status).toBe('ok');
});

test('app shell renders without client-side errors', async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/');

  await expect(page).toHaveTitle('Global Softel RAG Chat');
  // Sidebar identity.
  await expect(page.locator('aside').getByText('Global Softel RAG', { exact: true })).toBeVisible();
  // Primary navigation is present (disabled until a project is active).
  await expect(page.getByRole('button', { name: 'Chat' })).toBeAttached();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeAttached();

  expect(pageErrors, 'no uncaught page errors').toEqual([]);
  expect(consoleErrors.filter((t) => !isBenignConsoleError(t)), 'no console errors').toEqual([]);
});

test('onboarding offers a first project and creates one', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Global Softel RAG Chat');

  const projectName = `Onboarding ${Date.now()}`;
  const welcome = page.getByText('Welcome to Global Softel RAG Chat');

  // The welcome screen only appears on a truly empty database; the sidebar "New"
  // button works in both states, so fall back to it if the list is non-empty.
  if (await welcome.isVisible().catch(() => false)) {
    await expect(
      page.getByText('Create a project to hold a set of documents', { exact: false }),
    ).toBeVisible();
    // The sidebar also offers a "Create your first project" button, so scope to
    // the main content area to avoid a strict-mode violation.
    await page.getByRole('main').getByRole('button', { name: 'Create your first project' }).click();
  } else {
    // `exact` keeps this from also matching the sidebar's "New conversation" button.
    await page.locator('aside').getByRole('button', { name: 'New', exact: true }).click();
  }

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('e.g. Platform API Specification').fill(projectName);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog).toBeHidden();

  // The new project becomes active: the chat header shows it and the composer
  // is ready for a question.
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible();
  // The chat header confirms the new project is active. Scope to <main> so the
  // hidden <option> of the sidebar project <select> cannot match.
  await expect(page.getByRole('main').locator('header').first()).toContainText(projectName);
  await expect(page.getByPlaceholder(/Ask a question/)).toBeVisible();
});
