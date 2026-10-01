import { expect, test } from '@playwright/test';
import { type LabelsPickWebGPUState, WEBGPU_SAMPLE_POINTS } from './labelsPickWebGPUContract';

// WebGPU is behind a flag in headless Chromium; the default config only sets up
// SwiftShader's WebGL path.
test.use({
  launchOptions: {
    args: ['--enable-unsafe-webgpu', '--use-gl=angle', '--use-angle=swiftshader'],
  },
});

test('labels are pickable on a WebGPU deck in the built layers artifact', async ({ page }) => {
  // deck 9.4's pick path converts the pointer to WebGL's bottom-left origin
  // (`cssToDevicePixels(…, true)` in deck-picker) on WebGPU too, whose textures are
  // top-left, so every pick reads the vertically mirrored pixel. Remove once fixed:
  // Playwright then reports this as an unexpected pass.
  test.fail();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?scenario=labels-pick-webgpu', { waitUntil: 'networkidle' });

  const hasWebGPU = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()));
  test.skip(!hasWebGPU, 'No WebGPU adapter in this browser');

  await expect
    .poll(() => page.evaluate(() => window.labelsPickWebGPU?.ready ?? false), { timeout: 15_000 })
    .toBe(true);
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
});
