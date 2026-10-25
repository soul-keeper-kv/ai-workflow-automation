import { UI_URL } from '../support/constants.js';
import { expect, headerStatus, startDemo, test } from '../support/fixtures.js';

test('cancels a running execution from the monitor', async ({ page }) => {
  await startDemo(page, { items: 'a\nb\nc\nd', delayMs: 2_000 });

  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Confirm cancel' }).click();

  await expect(headerStatus(page)).toHaveText('Cancelled');
  await expect(page.getByText('CANCELLED: Cancelled while this step was running.')).toBeVisible();
});

test('keeps the history across a backend restart', async ({ page, stack }) => {
  const id = await startDemo(page, { items: 'persist me', delayMs: 0, review: false });
  await expect(headerStatus(page)).toHaveText('Completed');

  await stack.crashBackend();
  await stack.startBackend();

  await page.goto(`${UI_URL}/executions/detail?id=${id}`);
  await expect(headerStatus(page)).toHaveText('Completed');
  await expect(page.locator('pre').first()).toContainText('PERSIST ME');
});

test.describe('after a crash during an AI step', () => {
  test.use({ stackOptions: { fakeAgentDelayMs: 30_000 } });

  test('marks the execution interrupted, then resumes it when the person asks', async ({
    page,
    stack,
  }) => {
    await page.goto(`${UI_URL}/workflows/start?id=generate-spec`);
    await page.getByLabel(/Source directory/).fill(stack.sampleApp);
    await page.getByLabel(/Output directory/).fill(stack.specsDir);
    await page.getByRole('button', { name: 'Start execution' }).click();
    await page.waitForURL(/\/executions\/detail\?id=/);
    await expect(
      page.getByLabel('Workflow progress').locator('[data-phase="running"]'),
    ).toContainText('Generate draft spec');

    // The generation step calls an external agent, so it is not re-run on its own.
    await stack.crashBackend();
    await stack.startBackend();
    await page.reload();

    await expect(headerStatus(page)).toHaveText('Interrupted');
    const resume = page.getByTestId('resume-panel');
    await expect(resume).toContainText('Generate draft spec');
    await resume.getByRole('button', { name: 'Resume…' }).click();
    await resume.getByRole('button', { name: 'Re-run step' }).click();

    await expect(headerStatus(page)).toHaveText('Running');
    await expect(
      page
        .getByLabel('Workflow progress')
        .locator('[data-phase="interrupted"], [data-phase="running"]'),
    ).toHaveCount(1);
  });
});
