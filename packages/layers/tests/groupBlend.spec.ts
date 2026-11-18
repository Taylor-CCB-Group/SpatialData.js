import { describe, expect, it } from 'vitest';
import { type GroupBlendMode, groupBlendParameters } from '../src/groups/groupBlend';

type Rgba = [number, number, number, number];

/** Fixed-function blending as a GPU applies it, for the factors the modes use. */
function blend(mode: GroupBlendMode, src: Rgba, dst: Rgba): Rgba {
  const p = groupBlendParameters(mode);
  const factor = (name: unknown, channel: number): number => {
    const alpha = channel === 3;
    switch (name) {
      case 'zero':
        return 0;
      case 'one':
        return 1;
      case 'src':
        return alpha ? src[3] : (src[channel] ?? 0);
      case 'one-minus-src':
        return 1 - (alpha ? src[3] : (src[channel] ?? 0));
      case 'dst':
        return alpha ? dst[3] : (dst[channel] ?? 0);
      case 'src-alpha':
        return src[3];
      case 'one-minus-src-alpha':
        return 1 - src[3];
      case 'dst-alpha':
        return dst[3];
      case 'one-minus-dst-alpha':
        return 1 - dst[3];
      default:
        throw new Error(`factor ${String(name)} not modelled`);
    }
  };
  const channel = (i: number): number => {
    const alpha = i === 3;
    const op = alpha ? p.blendAlphaOperation : p.blendColorOperation;
    const s = src[i] ?? 0;
    const d = dst[i] ?? 0;
    if (op === 'max') return Math.max(s, d);
    if (op === 'min') return Math.min(s, d);
    const sf = factor(alpha ? p.blendAlphaSrcFactor : p.blendColorSrcFactor, i);
    const df = factor(alpha ? p.blendAlphaDstFactor : p.blendColorDstFactor, i);
    return s * sf + d * df;
  };
  return [channel(0), channel(1), channel(2), channel(3)];
}

// Premultiplied: opaque red over opaque green, and each over nothing.
const RED: Rgba = [1, 0, 0, 1];
const GREEN: Rgba = [0, 1, 0, 1];
const EMPTY: Rgba = [0, 0, 0, 0];

describe('groupBlendParameters compositing operators', () => {
  it.each<[GroupBlendMode, Rgba, Rgba, Rgba]>([
    // [mode, overlap, source only, destination only]
    ['intersect', GREEN, EMPTY, EMPTY],
    ['cut-out', EMPTY, EMPTY, GREEN],
    ['xor', EMPTY, RED, GREEN],
    ['clip', RED, EMPTY, GREEN],
  ])('%s keeps the Porter–Duff regions', (mode, overlap, sourceOnly, destinationOnly) => {
    expect(blend(mode, RED, GREEN)).toEqual(overlap);
    expect(blend(mode, RED, EMPTY)).toEqual(sourceOnly);
    expect(blend(mode, EMPTY, GREEN)).toEqual(destinationOnly);
  });

  it('scales a mask by a half-transparent source', () => {
    expect(blend('intersect', [0.5, 0, 0, 0.5], GREEN)).toEqual([0, 0.5, 0, 0.5]);
    expect(blend('cut-out', [0.5, 0, 0, 0.5], GREEN)).toEqual([0, 0.5, 0, 0.5]);
  });

  it('leaves the blend modes compositing alpha as over', () => {
    expect(blend('multiply', [0.5, 0, 0, 0.5], EMPTY)[3]).toBe(0.5);
  });
});
