import type { BlendFactor, Parameters } from '@luma.gl/core';

/** Porter–Duff operators: the group's contents act as a mask on what is beneath. */
export const GROUP_COMPOSITING_OPERATORS = ['intersect', 'cut-out', 'xor', 'clip'] as const;
export type GroupCompositingOperator = (typeof GROUP_COMPOSITING_OPERATORS)[number];

/** Blend modes an isolated group can composite with. All are fixed-function. */
export type GroupBlendMode =
  | 'normal'
  | 'additive'
  | 'multiply'
  | 'screen'
  | 'max'
  | 'min'
  | GroupCompositingOperator;

export function isGroupCompositingOperator(mode: string): mode is GroupCompositingOperator {
  return GROUP_COMPOSITING_OPERATORS.some((operator) => operator === mode);
}

/**
 * Blend state for drawing a group's offscreen target onto the backdrop.
 *
 * The target holds premultiplied colour on both backends: deck's WebGL default blend
 * (`SRC_ALPHA, ONE_MINUS_SRC_ALPHA` for colour) premultiplies as it draws into a cleared
 * target, and deck's WGSL layers premultiply in the shader. So every mode here is the
 * premultiplied form. Alpha composites as `over`, except under the Porter–Duff
 * operators, where it takes the same factors as colour.
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
  const porterDuff = (src: BlendFactor, dst: BlendFactor): Parameters => ({
    ...base,
    blendColorOperation: 'add',
    blendColorSrcFactor: src,
    blendColorDstFactor: dst,
    blendAlphaOperation: 'add',
    blendAlphaSrcFactor: src,
    blendAlphaDstFactor: dst,
  });
  switch (mode) {
    // Porter–Duff, as (source factor, destination factor) on colour and alpha alike.
    case 'intersect':
      return porterDuff('zero', 'src-alpha');
    case 'cut-out':
      return porterDuff('zero', 'one-minus-src-alpha');
    case 'xor':
      return porterDuff('one-minus-dst-alpha', 'one-minus-src-alpha');
    case 'clip':
      return porterDuff('dst-alpha', 'one-minus-src-alpha');
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
