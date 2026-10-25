import { UI_URL } from '../support/constants.js';
import { expect, headerStatus, startDemo, test } from '../support/fixtures.js';

test('shows progress, pauses for approval and completes once approved', async ({ page }) => {
  await startDemo(page, { items: 'alpha\nbeta', delayMs: 150 });

  await expect(page.getByLabel('Workflow progress')).toBeVisible();
  const panel = page.getByTestId('approval-panel');
  await expect(panel).toContainText('Processed 2 item(s): ALPHA, BETA.');
  await expect(headerStatus(page)).toHaveText('Awaiting approval');

  await page.getByLabel('Feedback (optional)').fill('Looks right');
  await panel.getByRole('button', { name: 'Approve' }).click();

  await expect(headerStatus(page)).toHaveText('Completed');
  await expect(page.locator('pre').first()).toContainText('"reviewFeedback": "Looks right"');
  await expect(page.getByText('approved', { exact: false }).first()).toBeVisible();
});

test('rejecting the review cancels the execution', async ({ page }) => {
  await startDemo(page, { items: 'one', delayMs: 50 });

  await page.getByTestId('approval-panel').getByRole('button', { name: 'Reject' }).click();

  await expect(headerStatus(page)).toHaveText('Cancelled');
  await expect(page.getByLabel('Workflow progress')).toContainText('Rejected');
});

test('retries a failing step and shows every attempt', async ({ page }) => {
  await startDemo(page, { items: 'x', delayMs: 20, failures: 2, review: false });

  await expect(headerStatus(page)).toHaveText('Completed', { timeout: 30_000 });
  await expect(page.getByLabel('Workflow progress')).toContainText('3 attempts');
  await expect(page.getByText('SIMULATED_FAILURE: Simulated failure 2 of 2.')).toBeVisible();
});

test('lists executions in the history, filtered by status', async ({ page }) => {
  await startDemo(page, { items: 'a', delayMs: 0, review: false });
  await expect(headerStatus(page)).toHaveText('Completed');
  await startDemo(page, { items: 'b', delayMs: 0 });
  await expect(headerStatus(page)).toHaveText('Awaiting approval');

  await page.goto(`${UI_URL}/executions`);
  await expect(page.getByRole('row')).toHaveCount(3); // header + 2

  await page.goto(`${UI_URL}/executions?status=WAITING_FOR_APPROVAL`);
  await expect(page.getByRole('row')).toHaveCount(2);

  await page.goto(`${UI_URL}/approvals`);
  await expect(page.getByRole('row')).toHaveCount(2);
});
