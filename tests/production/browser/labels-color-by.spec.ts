import { expect, test } from '@playwright/test';
import {
  CHANNEL_COLOR,
  LABEL_1_COLOR,
  LABEL_2_COLOR,
  type LabelsColorBySamples,
  SAMPLE_POINTS,
} from './labelsColorByContract';

/**
 * SwiftShader is exact for this scenario (flat fills, no filtering, no AA at the
 * sample points), but a byte of slack costs nothing and keeps the test from
 * pinning a rounding path rather than the behaviour.
 */
const CHANNEL_TOLERANCE = 4;

function describeColor(color: readonly number[]): string {
  return `rgba(${color.join(', ')})`;
}

function expectColor(actual: readonly number[], expected: readonly number[], label: string) {
  const maxDrift = Math.max(
    ...expected.map((channel, index) => Math.abs(channel - (actual[index] ?? 0)))
  );
  expect(
    maxDrift,
    `${label}: expected ${describeColor(expected)}, got ${describeColor(actual)}`
  ).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
}

test('labels feature colouring reaches the GPU in the built layers artifact', async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?scenario=labels-color-by', { waitUntil: 'networkidle' });
  await expect
    .poll(() => page.evaluate(() => Boolean(document.createElement('canvas').getContext('webgl2'))))
    .toBe(true);
  await expect(page.getByTestId('labels-ready')).toBeAttached();

  // Wait for the synthetic raster to have loaded and drawn: until then the
  // sampled pixels are the empty canvas, which would fail for the wrong reason.
  await expect
    .poll(() => page.evaluate(() => window.labelsColorBySamples?.label1[3] ?? 0), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  await page.screenshot({ path: testInfo.outputPath('labels-color-by.png') });

  const runtime = await page.evaluate(() => ({
    samples: window.labelsColorBySamples as LabelsColorBySamples,
    deckErrors: window.labelsColorByDeckErrors,
    frames: window.labelsColorByRenderFrames,
  }));

  expect(runtime.deckErrors).toEqual([]);
  expect(runtime.frames).toBeGreaterThan(0);

  // The regression this pins: both bands come back in the CHANNEL colour when the
  // feature LUT does not reach the shader, which is indistinguishable from
  // "colour-by does nothing" in the app.
  expect(
    describeColor(runtime.samples.label1),
    'label 1 drew in the channel colour — feature colouring did not reach the shader'
  ).not.toBe(describeColor([...CHANNEL_COLOR, 255]));

  expectColor(runtime.samples.label1, LABEL_1_COLOR, 'label 1');
  expectColor(runtime.samples.label2, LABEL_2_COLOR, 'label 2');

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('labels are pickable in the built layers artifact', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?scenario=labels-color-by', { waitUntil: 'networkidle' });
  // Picking before the raster has drawn would find nothing for the wrong reason.
  await expect
    .poll(() => page.evaluate(() => window.labelsColorBySamples?.label1[3] ?? 0), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  const picks = await page.evaluate(
    ([label1, label2]) => ({
      label1: window.labelsColorByPick?.(label1[0], label1[1]) ?? null,
      label2: window.labelsColorByPick?.(label2[0], label2[1]) ?? null,
    }),
    [SAMPLE_POINTS.label1, SAMPLE_POINTS.label2] as const
  );

  // `null` for both is the deck 9.4 regression: the shader read a picking-colour
  // attribute deck no longer supplies, so the layer never registered in the pick
  // pass and hover, highlight and tooltips all went dead.
  expect(picks).toEqual({ label1: 1, label2: 2 });
  expect(pageErrors).toEqual([]);
});
