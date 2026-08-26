import { expect, test } from '@playwright/test';

/**
 * The published worker entry, started the way a consumer starts it. All of this is
 * bundler-shaped and invisible to unit tests: the `exports` subpath must resolve,
 * the emitted file must be an ES module (#148), and the worker's own bundle must
 * resolve parquet-wasm independently of the main thread's copy.
 */
test('the published parquet worker starts in a consumer build and decodes', async ({ page }) => {
  const failures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() === 404) failures.push(`404 ${response.url()}`);
  });

  await page.goto('/?scenario=parquet-worker');

  await expect(page.getByTestId('worker-ready')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('worker-ready')).toContainText(/decoded \d+ features/);
  expect(failures, failures.join('\n')).toEqual([]);
});
