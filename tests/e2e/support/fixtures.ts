import { test as base, expect, type Page } from '@playwright/test';
import { Stack } from './stack.js';
import { UI_URL } from './constants.js';

export const test = base.extend<{ stackOptions: { fakeAgentDelayMs?: number }; stack: Stack }>({
  stackOptions: [{}, { option: true }],
  // Automatic: every test gets its own backend and UI, whether it touches `stack` or not.
  stack: [
    async ({ stackOptions }, use) => {
      const stack = new Stack(stackOptions);
      await stack.start();
      await use(stack);
      await stack.stop();
    },
    { auto: true },
  ],
});

export { expect };

export async function startDemo(
  page: Page,
  options: { items: string; delayMs: number; review?: boolean; failures?: number },
): Promise<string> {
  await page.goto(`${UI_URL}/workflows/start?id=demo-sequence`);
  await page.getByLabel(/Items/).fill(options.items);
  await page.getByLabel(/Delay per step/).fill(String(options.delayMs));
  await page.getByLabel(/Simulated failures/).fill(String(options.failures ?? 0));
  if (options.review === false)
    await page.getByRole('checkbox', { name: /Ask for review/ }).click();
  await page.getByRole('button', { name: 'Start execution' }).click();
  await page.waitForURL(/\/executions\/detail\?id=/);
  return new URL(page.url()).searchParams.get('id') ?? '';
}

/** The status badge in the execution header. */
export function headerStatus(page: Page) {
  return page.locator('header [data-status]');
}
