import { describe, expect, it, vi } from 'vitest';

const modelOptions = vi.hoisted((): Array<{ shaderAssembler?: unknown }> => []);

vi.mock('@luma.gl/engine', () => ({
  Model: class {
    constructor(_device: unknown, options: { shaderAssembler?: unknown }) {
      modelOptions.push(options);
    }
  },
}));

import { FlatPolygonLayer } from '../src/FlatPolygonLayer';

describe('FlatPolygonLayer shaders', () => {
  it('uses Deck’s shader assembler when creating its hand-rolled Model', () => {
    const layer = new FlatPolygonLayer({
      id: 'flat-polygon-shader-modules',
      ringPositions: new Float32Array([0, 0, 1, 0, 0, 1]),
      ringVertexCount: 3,
      triangleData: new Uint32Array([0, 1, 2, 7]),
      triangleCount: 1,
      featureColors: new Uint8Array([0, 0, 0, 255]),
      featureCount: 1,
      featureScale: new Float32Array([1]),
    });
    const shaderAssembler = {};
    layer.context = { defaultShaderModules: [], shaderAssembler };

    layer._getModel();

    expect(modelOptions.at(-1)).toMatchObject({ shaderAssembler });
  });
});
