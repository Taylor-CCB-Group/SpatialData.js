import { beforeEach, describe, expect, it, vi } from 'vitest';

const modelOptions = vi.hoisted((): Array<{ shaderAssembler?: unknown }> => []);
const modelInstances = vi.hoisted((): Array<{ destroy: ReturnType<typeof vi.fn> }> => []);

vi.mock('@luma.gl/engine', () => ({
  Model: class {
    destroy = vi.fn();

    constructor(_device: unknown, options: { shaderAssembler?: unknown }) {
      modelOptions.push(options);
      modelInstances.push(this);
    }
  },
}));

import { FlatPolygonLayer } from '../src/FlatPolygonLayer';

function makeProps() {
  return {
    id: 'flat-polygon-shader-modules',
    ringPositions: new Float32Array([0, 0, 1, 0, 0, 1]),
    ringVertexCount: 3,
    triangleData: new Uint32Array([0, 1, 2, 7]),
    triangleCount: 1,
    featureColors: new Uint8Array([0, 0, 0, 255]),
    featureCount: 1,
    featureScale: new Float32Array([1]),
  };
}

describe('FlatPolygonLayer shaders', () => {
  beforeEach(() => {
    modelOptions.length = 0;
    modelInstances.length = 0;
  });

  it("uses Deck's shader assembler when creating its hand-rolled Model", () => {
    const layer = new FlatPolygonLayer(makeProps());
    const shaderAssembler = {};
    layer.context = { defaultShaderModules: [], shaderAssembler };

    layer._getModel();

    expect(modelOptions.at(-1)).toMatchObject({ shaderAssembler });
  });

  it("does not recreate the model for Deck's first forced extensionsChanged update", () => {
    const props = makeProps();
    const layer = new FlatPolygonLayer(props);
    const initialModel = { destroy: vi.fn() };
    layer.state = { model: initialModel };
    layer.context = { defaultShaderModules: [], shaderAssembler: {}, device: {} };

    layer.updateState({ props, oldProps: { ...props }, changeFlags: { extensionsChanged: true } });

    expect(initialModel.destroy).not.toHaveBeenCalled();
    expect(modelOptions).toHaveLength(0);
  });

  it('recreates the model for later extension changes', () => {
    const props = makeProps();
    const layer = new FlatPolygonLayer(props);
    const initialModel = { destroy: vi.fn() };
    layer.state = { model: initialModel };
    layer.context = { defaultShaderModules: [], shaderAssembler: {}, device: {} };

    layer.updateState({
      props,
      oldProps: { ...props, extensions: [] },
      changeFlags: { extensionsChanged: true },
    });

    expect(initialModel.destroy).toHaveBeenCalledOnce();
    expect(modelInstances).toHaveLength(1);
  });
});
