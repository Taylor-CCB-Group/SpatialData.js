import type { Parameters } from '@luma.gl/core';

/** Blend modes an isolated group can composite with. All are fixed-function. */
export type GroupBlendMode = 'normal' | 'additive' | 'multiply' | 'screen' | 'max' | 'min';

/**
 * Blend state for drawing a group's offscreen target onto the backdrop.
 *
 * The target holds premultiplied colour on both backends: deck's WebGL default blend
 * (`SRC_ALPHA, ONE_MINUS_SRC_ALPHA` for colour) premultiplies as it draws into a cleared
 * target, and deck's WGSL layers premultiply in the shader. So every mode here is the
 * premultiplied form. Alpha always composites as `over`.
 *
 * `min` cannot be expressed against a premultiplied source directly — empty pixels
 * would darken the backdrop to black — so the composite shader first composites the
 * target over white for that mode (see `backdropWhite` in the composite layer).
 */
export function groupBlendParameters(mode: GroupBlendMode): Parameters {
  const alphaOver = {
    blendAlphaOperation: 'add',
    blendAlphaSrcFactor: 'one',
    blendAlphaDstFactor: 'one-minus-src-alpha',
  } as const;
  const base = {
    blend: true,
    depthWriteEnabled: false,
    depthCompare: 'always',
    ...alphaOver,
  } as const;
  switch (mode) {
    case 'additive':
      return {
        ...base,
        blendColorOperation: 'add',
        blendColorSrcFactor: 'one',
        blendColorDstFactor: 'one',
      };
    case 'multiply':
      // src·dst + dst·(1 − αs) = dst · lerp(1, src, αs) for a premultiplied source.
      return {
        ...base,
        blendColorOperation: 'add',
        blendColorSrcFactor: 'dst',
        blendColorDstFactor: 'one-minus-src-alpha',
      };
    case 'screen':
      return {
        ...base,
        blendColorOperation: 'add',
        blendColorSrcFactor: 'one',
        blendColorDstFactor: 'one-minus-src',
      };
    case 'max':
    case 'min':
      // WebGPU requires `one` factors with min/max operations.
      return {
        ...base,
        blendColorOperation: mode,
        blendColorSrcFactor: 'one',
        blendColorDstFactor: 'one',
      };
    default:
      return {
        ...base,
        blendColorOperation: 'add',
        blendColorSrcFactor: 'one',
        blendColorDstFactor: 'one-minus-src-alpha',
      };
  }
}
