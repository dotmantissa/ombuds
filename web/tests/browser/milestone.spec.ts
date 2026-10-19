import { test, expect } from '@playwright/test';

test('local document review removes identifiers without transmitting the letter', async ({ page }) => {
  const outgoing: string[] = [];
  page.on('request', (r) => { if (r.postData()) outgoing.push(r.postData()!); });
  await page.goto('/file');
  const raw = 'Patient Name: Jane Example\nMember ID: 43644\nSSN 999-12-3456\nCPT 43775 and ICD-10 E66.01\nBenefit denied because the requested procedure is considered not medically necessary under the clinical policy.';
  await page.locator('textarea').first().fill(raw);
  await page.getByRole('button', { name: /scan|scrub/i }).click();
  await expect(page.getByText('Automatic privacy scan completed. Review what remains.')).toBeVisible();
  await page.getByText('Sanitized document preview').click();
  const preview = page.locator('pre');
  await expect(preview).not.toContainText('Jane Example');
  await expect(preview).not.toContainText('999-12-3456');
  await expect(preview).toContainText('43775');
  await page.getByLabel('Edit procedure codes').fill('43775');
  await page.getByRole('button', { name: 'Pick the plan rule' }).click();
  await page.getByLabel('Date of service', { exact: false }).fill('2026-04-12');
  await page.locator('#amount').fill('12000');
  await page.getByRole('button', { name: 'Review and file' }).click();
  await expect(page.getByRole('button', { name: 'Open the case' })).toBeDisabled();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  expect(outgoing.every((data) => !data.includes('Jane Example') && !data.includes('999-12-3456'))).toBeTruthy();
});

test('case search and preserved appeal evidence are connected to the local contracts', async ({ page }) => {
  await page.goto('/docket');
  await expect(page.getByRole('link', { name: 'OMB-2026-000001' })).toBeVisible();
  await page.getByLabel('Search cases').fill('not-present');
  await page.getByRole('button', { name: 'Search cases' }).click();
  await expect(page.getByText('No cases in this view.')).toBeVisible();
  await page.goto('/case/OMB-2026-000001');
  await expect(page.getByRole('heading', { name: 'Case and appeal timeline' })).toBeVisible();
  await expect(page.getByText('Appeal decided', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Evidence explorer' })).toBeVisible();
  await expect(page.getByText('Round 1 · Overturn recommended', { exact: false })).toBeVisible();
  await expect(page.getByText('Round 2 · Denial upheld', { exact: false })).toBeVisible();
  await expect(page.getByText('The decision changed.', { exact: false })).toBeVisible();
});

test('capital history, funded retry and policy revisions render from contract state', async ({ page }) => {
  await page.goto('/pool');
  await expect(page.getByRole('heading', { name: 'Pool transaction history' })).toBeVisible();
  await expect(page.getByText('Emitted · delivery unverified').first()).toBeVisible();
  await expect(page.getByText('Payment 1 · attempt 2', { exact: false })).toBeVisible();
  await page.goto('/policies');
  await expect(page.getByRole('heading', { name: 'Registration and revision history' })).toBeVisible();
  await expect(page.getByText('Version 2 · EXTENDED')).toBeVisible();
  await expect(page.getByRole('link', { name: 'OMB-2026-000001' })).toBeVisible();
});

test('signed-out account, authentication and narrow screens remain usable', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/account');
  await expect(page.getByText('Sign in to see your cases, underwriting position and transaction history.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(errors).toEqual([]);
  expect((await request.post('/api/cases', { data: {} })).status()).toBe(401);
  expect((await request.get('/api/activity')).status()).toBe(401);
});
