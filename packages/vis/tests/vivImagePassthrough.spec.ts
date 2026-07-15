import { describe, expect, it } from 'vitest';
import { mergeVivImagePassthroughProps } from '../src/SpatialCanvas/vivImagePassthrough.js';

describe('mergeVivImagePassthroughProps', () => {
  it('merges saved and resolved props with resolved extensions winning over global', () => {
    const globalExt = [{ id: 'global' }];
    const resolvedExt = [{ id: 'layer' }];
    const merged = mergeVivImagePassthroughProps(
      { brightness: [0.2], foo: 1 },
      { contrast: [0.8], foo: 2 },
      resolvedExt,
      globalExt
    );
    expect(merged).toEqual({
      brightness: [0.2],
      contrast: [0.8],
      foo: 2,
      extensions: resolvedExt,
    });
  });

  it('falls back to global extensions when resolver returns nothing', () => {
    const globalExt = [{ id: 'global' }];
    const merged = mergeVivImagePassthroughProps(
      { brightness: [0.5] },
      undefined,
      undefined,
      globalExt
    );
    expect(merged.extensions).toEqual(globalExt);
  });
});
