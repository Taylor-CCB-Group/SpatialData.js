import { expect, type Page, test } from '@playwright/test';
import { type LabelsPickWebGPUState, WEBGPU_SAMPLE_POINTS } from './labelsPickWebGPUContract';
import { WEBGPU_LAUNCH_ARGS } from './webgpuLaunchArgs';

test.use({ launchOptions: { args: WEBGPU_LAUNCH_ARGS } });

async function expectLabelsPickable(page: Page, fix: boolean) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(`/?scenario=labels-pick-webgpu${fix ? '&fix=1' : ''}`, {
    waitUntil: 'networkidle',
  });

  const adapter = await page.evaluate(async () => {
    const found = await navigator.gpu?.requestAdapter();
    if (!found) return null;
    const { vendor, architecture, description } = found.info;
    return `${vendor} ${architecture} ${description}`.trim();
  });
  test.skip(!adapter, 'No WebGPU adapter in this browser');
  test.info().annotations.push({ type: 'webgpu adapter', description: adapter ?? '' });

  await expect
    .poll(() => page.evaluate(() => window.labelsPickWebGPU?.ready ?? false), {
      timeout: 15_000,
      message: 'labels raster never became pickable',
    })
    .toBe(true)
    .catch(async (error: Error) => {
      const state = await page.evaluate(() => window.labelsPickWebGPU);
      throw new Error(
        `${error.message}\nadapter: ${adapter}\nstate: ${JSON.stringify(state)}\n` +
          `page errors: ${JSON.stringify(pageErrors)}\nconsole errors: ${JSON.stringify(consoleErrors)}`
      );
    });
  const state = await page.evaluate<LabelsPickWebGPUState>(() => window.labelsPickWebGPU);
  // A silent fallback to WebGL would pass for the wrong reason.
  expect(state.deviceType).toBe('webgpu');

  const picks = await page.evaluate(async ({ label1, label2, background }) => {
    const at = window.labelsPickWebGPUAt;
    if (!at) return null;
    return {
      label1: await at(label1[0], label1[1]),
      label2: await at(label2[0], label2[1]),
      background: await at(background[0], background[1]),
    };
  }, WEBGPU_SAMPLE_POINTS);

  // Labels sit in opposite quadrants, so a vertically mirrored pick reads
  // background and comes back `null` for both.
  expect(picks).toEqual({ label1: 1, label2: 2, background: null });
  expect(state.errors).toEqual([]);
  expect(pageErrors).toEqual([]);
}

test('labels are pickable on WebGPU with applyWebGPUPickingFix', async ({ page }) => {
  await expectLabelsPickable(page, true);
});

test('deck alone picks WebGPU labels at the mirrored pixel', async ({ page }) => {
  // deck 9.4's pick path converts the pointer to WebGL's bottom-left origin
  // (`cssToDevicePixels(…, true)` in deck-picker) on WebGPU too, whose textures are
  // top-left, so every pick reads the vertically mirrored pixel. Once deck is fixed
  // Playwright reports an unexpected pass here: delete this test and
  // `applyWebGPUPickingFix`.
  test.fail();
  await expectLabelsPickable(page, false);
});
