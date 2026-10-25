import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UI_URL } from '../support/constants.js';
import { expect, headerStatus, test } from '../support/fixtures.js';

test('drafts a spec, shows it for review and saves it once approved', async ({ page, stack }) => {
  await page.goto(`${UI_URL}/workflows/start?id=generate-spec`);
  await expect(page.getByTestId('requirements-notice')).toContainText(
    'Fake agent (offline, no AI)',
  );

  await page.getByLabel(/Source directory/).fill(stack.sampleApp);
  await page.getByLabel(/Output directory/).fill(stack.specsDir);
  await page.getByLabel(/Spec title/).fill('Customer search');
  await page.getByRole('button', { name: 'Start execution' }).click();
  await page.waitForURL(/\/executions\/detail\?id=/);

  const panel = page.getByTestId('approval-panel');
  await expect(panel).toContainText('# Customer search');
  await expect(panel).toContainText('src/customer-search-page.tsx');
  await panel.getByRole('button', { name: 'Approve' }).click();

  await expect(headerStatus(page)).toHaveText('Completed');
  const saved = readdirSync(stack.specsDir);
  expect(saved).toHaveLength(1);
  const content = readFileSync(join(stack.specsDir, saved[0] ?? ''), 'utf8');
  expect(content).toContain('generated_by: "Fake agent (offline, no AI)"');
  expect(content).toContain('## Assumptions and unresolved questions');
});

test('refuses a source folder outside the allowed workspace', async ({ page, stack }) => {
  await page.goto(`${UI_URL}/workflows/start?id=generate-spec`);
  await page.getByLabel(/Source directory/).fill(join(stack.base, 'data'));
  await page.getByLabel(/Output directory/).fill(stack.specsDir);
  await page.getByRole('button', { name: 'Start execution' }).click();
  await page.waitForURL(/\/executions\/detail\?id=/);

  await expect(headerStatus(page)).toHaveText('Failed');
  await expect(page.getByText('PATH_NOT_ALLOWED').first()).toBeVisible();
  // The source is checked first, so nothing was created or written.
  expect(existsSync(stack.specsDir)).toBe(false);
});
