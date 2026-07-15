import * as core from '@spatialdata/core';
import { describe, expect, it } from 'vitest';
import * as layers from '../src/index.js';

/**
 * ADR 0004 §5 makes `@spatialdata/core` the canonical home of the Render Stack
 * schemas, and promises that `@spatialdata/layers` and `@spatialdata/vis` keep
 * their re-exports as **compatibility shims** — MDV consumes these as a data
 * contract, and no consumer import may move.
 *
 * That promise is exactly the kind that rots silently: an `export … from` chain
 * still typechecks if someone re-declares a schema locally, and the drift only
 * shows up in a downstream repo. So assert it here — the shim must resolve to the
 * *same object*, not merely to an equivalent one.
 */

const SHIMMED_VALUES = [
  'RENDER_STACK_SCHEMA_VERSION',
  'renderStackSchema',
  'renderStackEntrySchema',
  'renderStackSpatialEntrySchema',
  'renderStackHostEntrySchema',
  'renderStackGroupEntrySchema',
  'renderStackSpatialElementTypeSchema',
  'getRenderStackEntryIds',
  'getRenderStackHostLayerIds',
  'SPATIAL_LAYER_PROPS_SCHEMA_VERSION',
  'spatialLayerPropsSchema',
  'spatialSublayerSchema',
  'migrateSpatialLayerProps',
] as const;

describe('render-stack compatibility shim (ADR 0004 §5)', () => {
  it.each(SHIMMED_VALUES)('layers re-exports %s by identity from core', (name) => {
    expect(layers[name]).toBeDefined();
    expect(layers[name]).toBe(core[name]);
  });

  it('the schemas still parse — the shim is not just a name, it is the behaviour', () => {
    const stack = layers.renderStackSchema.parse({
      schemaVersion: layers.RENDER_STACK_SCHEMA_VERSION,
      entries: [
        {
          id: 'cells',
          kind: 'spatial',
          source: { elementType: 'shapes', elementKey: 'cells' },
        },
        {
          id: 'mdv-scatter',
          kind: 'host',
          source: { hostLayerId: 'deck:scatter' },
        },
      ],
    });

    expect(layers.getRenderStackEntryIds(stack)).toEqual(['cells', 'mdv-scatter']);
    expect(layers.getRenderStackHostLayerIds(stack)).toEqual(['deck:scatter']);
  });
});
