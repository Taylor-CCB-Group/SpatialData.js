import { expect, test } from '@playwright/test';

// Zarrita probes a root or nested Zarr metadata file before falling back to the
// fixture's inline consolidated metadata. The fixture deliberately omits some of
// those files; only those exact 404s are tolerated.
const expectedMetadata404 =
  /\/test-fixtures\/v0\.7\.2\/blobs\.zarr\/(?:.*\/)?(?:zarr\.json|\.zmetadata|\.zattrs|\.zgroup)$/;
const expectedMetadataConsoleError =
  /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/;

test('the built layer consumer renders canonical polygon shapes without WebGL errors', async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let expectedMetadata404Count = 0;
  const unexpected404Urls: string[] = [];
  let expectedMetadataConsoleErrorCount = 0;

  page.on('response', (response) => {
    if (response.status() === 404 && expectedMetadata404.test(response.url())) {
      expectedMetadata404Count += 1;
    }
    if (response.status() === 404 && !expectedMetadata404.test(response.url())) {
      unexpected404Urls.push(response.url());
    }
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (expectedMetadataConsoleError.test(message.text())) {
      expectedMetadataConsoleErrorCount += 1;
      return;
    }
    consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/', { waitUntil: 'networkidle' });
  await expect
    .poll(() => page.evaluate(() => Boolean(document.createElement('canvas').getContext('webgl2'))))
    .toBe(true);
  await expect(page.getByTestId('fixture-ready')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('canvas').length)).toBe(1);
  await page.waitForTimeout(500);
  await page.screenshot({ path: testInfo.outputPath('polygon-shapes.png') });
  const runtime = await page.evaluate(() => ({
    frames: window.polygonShapesRenderFrames,
    deckErrors: window.polygonShapesDeckErrors,
    canvasCount: document.querySelectorAll('canvas').length,
  }));
  expect(runtime).toMatchObject({ deckErrors: [], canvasCount: 1 });
  expect(runtime.frames).toBeGreaterThan(1);

  expect(pageErrors).toEqual([]);
  expect({
    consoleErrors,
    unexpected404Urls,
    unmatchedExpectedMetadataConsoleErrors: Math.max(
      0,
      expectedMetadataConsoleErrorCount - expectedMetadata404Count
    ),
  }).toEqual({
    consoleErrors: [],
    unexpected404Urls: [],
    unmatchedExpectedMetadataConsoleErrors: 0,
  });
});
