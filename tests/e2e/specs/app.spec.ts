import { UI_URL } from '../support/constants.js';
import { expect, test } from '../support/fixtures.js';

test('opens the app, connects to the backend and shows the integrations', async ({
  page,
  stack,
}) => {
  await page.goto(UI_URL);

  await expect(page.getByTestId('backend-status').getByText('Connected')).toBeVisible();
  const integrations = page.getByTestId('integrations');
  await expect(integrations).toContainText('Fake agent (offline, no AI)');
  await expect(integrations).toContainText(stack.workspace);
});

test('lists the registered workflows from the backend, with what they use', async ({ page }) => {
  await page.goto(`${UI_URL}/workflows`);

  await expect(page.getByTestId('workflow-demo-sequence')).toContainText('Demo sequence');
  const spec = page.getByTestId('workflow-generate-spec');
  await expect(spec).toContainText('Uses an AI coding agent');
  await expect(spec).toContainText('Required inputs: Source directory, Output directory');
});
