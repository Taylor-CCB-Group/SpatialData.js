import { describe, expect, it } from 'vitest';
import { describeResolveInputs } from '../src/SpatialCanvas/resolveInputs.js';
import type { LayerConfig } from '../src/SpatialCanvas/types.js';

/**
 * The key has two jobs and they pull against each other: it must move for every
 * config change that starts a LOAD (or an in-place caller never gets its data), and
 * it must NOT move for a cosmetic one (or every opacity drag replans the world).
 * Both halves are pinned here.
 */

const shapes = (extra: Partial<Extract<LayerConfig, { type: 'shapes' }>> = {}): LayerConfig => ({
  id: 'layer-1',
  type: 'shapes',
  elementKey: 'cells',
  visible: true,
  opacity: 1,
  ...extra,
});

const key = (config: LayerConfig) => describeResolveInputs({ [config.id]: config }, [config.id]);

describe('describeResolveInputs — what starts a load', () => {
  it('moves when the fill-colour column changes', () => {
    expect(
      key(shapes({ fillColorByColumn: { columnName: 'colA', mode: 'categorical' } }))
    ).not.toBe(key(shapes({ fillColorByColumn: { columnName: 'colB', mode: 'categorical' } })));
  });

  it('moves when the fill-colour column is cleared', () => {
    expect(
      key(shapes({ fillColorByColumn: { columnName: 'colA', mode: 'categorical' } }))
    ).not.toBe(key(shapes()));
  });

  it('moves when the tooltip fields change', () => {
    expect(key(shapes({ tooltipFields: ['a'] }))).not.toBe(key(shapes({ tooltipFields: ['b'] })));
  });

  it('moves when the element behind a layer changes', () => {
    expect(key(shapes())).not.toBe(key(shapes({ elementKey: 'nuclei' })));
  });

  it('moves when a layer is hidden', () => {
    expect(key(shapes())).not.toBe(key(shapes({ visible: false })));
  });

  it('moves for every points field a scan is planned from', () => {
    const points = (extra: Partial<Extract<LayerConfig, { type: 'points' }>>): LayerConfig => ({
      id: 'layer-p',
      type: 'points',
      elementKey: 'transcripts',
      visible: true,
      opacity: 1,
      ...extra,
    });
    const base = key(points({}));

    expect(key(points({ pointsMemoryCap: 1_000 }))).not.toBe(base);
    expect(key(points({ featureNames: ['EPCAM'] }))).not.toBe(base);
    expect(key(points({ featureCodes: [3] }))).not.toBe(base);
    expect(key(points({ colorByFeature: false }))).not.toBe(base);
  });

  it('separates two layers that would otherwise concatenate into the same key', () => {
    // `a` + `bc` must not read as `ab` + `c`: without a field separator, moving a
    // character across the boundary would be invisible to the effect.
    const one = describeResolveInputs(
      { a: shapes({ id: 'a', tooltipFields: ['x'] }), bc: shapes({ id: 'bc' }) },
      ['a', 'bc']
    );
    const two = describeResolveInputs(
      { ab: shapes({ id: 'ab', tooltipFields: ['x'] }), c: shapes({ id: 'c' }) },
      ['ab', 'c']
    );

    expect(one).not.toBe(two);
  });
});

describe('describeResolveInputs — what does not', () => {
  // The effect it keys runs `store.reconcile` for every entry. A key that moved on
  // a slider drag would put that on the drag's critical path for no load at all.
  it('ignores opacity, colours and stroke — nothing there is loaded', () => {
    const base = key(shapes());

    expect(key(shapes({ opacity: 0.3 }))).toBe(base);
    expect(key(shapes({ fillColor: [1, 2, 3, 4] }))).toBe(base);
    expect(key(shapes({ strokeColor: [1, 2, 3, 4], strokeWidth: 9 }))).toBe(base);
  });

  it('ignores the colour SCHEME of the fill column — same rows, different encoding', () => {
    const withColumn = shapes({ fillColorByColumn: { columnName: 'colA', mode: 'categorical' } });
    const withPalette = shapes({
      fillColorByColumn: {
        columnName: 'colA',
        mode: 'categorical',
        categoricalPalette: { A: [1, 2, 3] },
      },
    });

    expect(key(withPalette)).toBe(key(withColumn));
  });

  it('ignores per-feature state — a hidden or recoloured feature loads nothing new', () => {
    expect(
      key(
        shapes({
          featureState: { hiddenFeatureIds: ['c1'], fillColorByFeatureId: { c2: [1, 2, 3, 4] } },
        })
      )
    ).toBe(key(shapes()));
  });

  it('ignores image channel state — the images resolver plans off the element alone', () => {
    const image = (
      channels?: Extract<LayerConfig, { type: 'image' }>['channels']
    ): LayerConfig => ({
      id: 'layer-i',
      type: 'image',
      elementKey: 'morphology',
      visible: true,
      opacity: 1,
      ...(channels ? { channels } : {}),
    });

    expect(key(image({ colors: [[255, 0, 0]], contrastLimits: [[0, 100]] }))).toBe(key(image()));
  });
});
