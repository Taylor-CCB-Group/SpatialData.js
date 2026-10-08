import { expect, type Page, test } from '@playwright/test';
import { VIEWS_CLEAR_COLOR, type ViewsWebGPUState } from './viewsWebGPUContract';
import { WEBGPU_LAUNCH_ARGS } from './webgpuLaunchArgs';

test.use({ launchOptions: { args: WEBGPU_LAUNCH_ARGS } });

async function expectInsetClearedInPlace(page: Page, fix: boolean) {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(`/?scenario=views-webgpu${fix ? '&fix=1' : ''}`, { waitUntil: 'networkidle' });

  const adapter = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
  test.skip(!adapter, 'No WebGPU adapter in this browser');

  await expect
    .poll(() => page.evaluate(() => window.viewsWebGPU?.samples !== null), {
      timeout: 15_000,
      message: 'deck never drew a frame',
    })
    .toBe(true);
  const state = await page.evaluate<ViewsWebGPUState>(() => window.viewsWebGPU);
  // A silent fallback to WebGL would pass for the wrong reason.
  expect(state.deviceType).toBe('webgpu');

  const transparent = [0, 0, 0, 0];
  expect(state.samples).toEqual({
    inset: [...VIEWS_CLEAR_COLOR],
    mirrored: transparent,
    outside: transparent,
  });
  expect(state.errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
}

test('an inset view clears in place on WebGPU with applyWebGPUViewFix', async ({ page }) => {
  await expectInsetClearedInPlace(page, true);
});

test('deck alone loses or mirrors a cleared inset view on WebGPU', async ({ page }) => {
  // deck 9.4 begins the view's clear pass while the view's own pass is open, which
  // invalidates the command buffer, and places views with WebGL's bottom-left y. Once
  // deck fixes both, Playwright reports an unexpected pass here: delete this test and
  // `applyWebGPUViewFix` — the fix's flip would then mirror views again.
  test.fail();
  await expectInsetClearedInPlace(page, false);
});
