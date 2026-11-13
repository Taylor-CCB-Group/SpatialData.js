import { getChannelStats } from '@hms-dbmi/viv';
import { describe, expect, it } from 'vitest';
import { computeChannelStats } from '../src/rasterStats';

// Deterministic PRNG so failures reproduce.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mostly-dark image with a long bright tail and a block of zero background,
// like a fluorescence channel.
function fill<T extends { length: number; [i: number]: number }>(
  arr: T,
  min: number,
  max: number,
  seed: number
): T {
  const rand = mulberry32(seed);
  for (let i = 0; i < arr.length; i++) {
    if (i % 7 === 0) arr[i] = 0;
    else arr[i] = Math.floor(min + (max - min) * rand() ** 4);
  }
  return arr;
}

function vivStats(data: Parameters<typeof getChannelStats>[0]) {
  const { domain, contrastLimits } = getChannelStats(data.slice());
  return { domain, contrastLimits };
}

describe('computeChannelStats', () => {
  const cases = [
    ['Uint8Array', fill(new Uint8Array(100_003), 0, 256, 1)],
    ['Uint16Array', fill(new Uint16Array(200_001), 0, 65536, 2)],
    ['Uint16Array, narrow range', fill(new Uint16Array(50_000), 100, 900, 3)],
    ['Int8Array', fill(new Int8Array(40_000), -128, 128, 4)],
    ['Int16Array', fill(new Int16Array(120_000), -32768, 32768, 5)],
    ['all zero', new Uint16Array(1000)],
    ['all negative', new Int16Array(1000).fill(-5)],
    ['single positive value', Uint16Array.of(0, 0, 7, 0)],
    ['one element', Uint8Array.of(42)],
    ['empty', new Uint16Array(0)],
  ] as const;

  it.each(cases)('matches Viv getChannelStats for %s', (_name, data) => {
    expect(computeChannelStats(data)).toEqual(vivStats(data));
  });

  it.each([
    ['Uint16Array', fill(new Uint16Array(10_000), 0, 65536, 6)],
    ['Float32Array', Float32Array.from({ length: 10_000 }, (_, i) => Math.sin(i) * 10)],
  ] as const)('does not reorder %s data', (_name, data) => {
    const before = data.slice();
    computeChannelStats(data);
    expect(data).toEqual(before);
  });

  it('defers to Viv for float data', () => {
    const data = Float32Array.from({ length: 5000 }, (_, i) => Math.sin(i) * 10);
    expect(computeChannelStats(data)).toEqual(expect.objectContaining(vivStats(data)));
  });
});
