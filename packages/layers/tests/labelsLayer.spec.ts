import { describe, expect, it, vi } from 'vitest';
import type { LabelsLayerProps } from '../src/LabelsLayer';
import { LabelsLayer } from '../src/LabelsLayer';
import { buildLabelColorLut, DEFAULT_LABEL_HIGHLIGHT_COLOR } from '../src/labelColorEncoding';

/** deck.gl core `Layer.defaultProps.highlightColor`. Not ours; must not leak in. */
const DECK_CORE_HIGHLIGHT_COLOR = [0, 0, 128, 128];

type TileLayerLike = {
  props: {
    updateTriggers?: { getTileData?: unknown[] };
    refinementStrategy?: string;
    renderSubLayers: (props: Record<string, unknown>) => unknown;
    [key: string]: unknown;
  };
  getTileData: (props: {
    index: { x: number; y: number; z: number };
    signal: AbortSignal;
  }) => Promise<unknown>;
};

function getTileTrigger(layer: TileLayerLike): unknown[] {
  return layer.props.updateTriggers?.getTileData ?? [];
}

function triggerChanged(a: TileLayerLike, b: TileLayerLike): boolean {
  const left = getTileTrigger(a);
  const right = getTileTrigger(b);
  return (
    left.length !== right.length || left.some((value, index) => !Object.is(value, right[index]))
  );
}

function makeLabelsLoader() {
  const onGetTile = vi.fn();
  const makeScale = (resolution: number) => ({
    shape: [512, 512],
    tileSize: 256,
    getTile: vi.fn(async ({ x, y, selection }: { x: number; y: number; selection: unknown }) => {
      onGetTile({ resolution, x, y, selection });
      return {
        data: new Float32Array([0, 1, 2, 0]),
        width: 2,
        height: 2,
      };
    }),
  });
  return {
    loader: [makeScale(0), makeScale(1)],
    onGetTile,
  };
}

function renderLabelsLayer(props: Record<string, unknown>): TileLayerLike {
  const layer = new LabelsLayer({
    id: 'labels-layer',
    visible: true,
    opacity: 1,
    selections: [{ z: 0, c: 0, t: 0 }],
    ...props,
  } as LabelsLayerProps);
  const rendered = layer.renderLayers();
  expect(rendered).toBeTruthy();
  return rendered as unknown as TileLayerLike;
}

async function loadOneTile(layer: TileLayerLike) {
  return layer.getTileData({
    index: { x: 0, y: 0, z: 0 },
    signal: new AbortController().signal,
  });
}

describe('LabelsLayer prop flow', () => {
  it('keeps cosmetic props out of the tile-data trigger', async () => {
    const { loader, onGetTile } = makeLabelsLoader();
    const initial = renderLabelsLayer({
      loader,
      opacity: 1,
      channelColors: [[255, 255, 255]],
      channelOpacities: [0.18],
      channelsFilled: [true],
      channelStrokeWidths: [1.5],
    });

    await loadOneTile(initial);
    expect(onGetTile).toHaveBeenCalledTimes(1);

    const cosmetic = renderLabelsLayer({
      loader,
      opacity: 0.35,
      channelColors: [[255, 0, 0]],
      channelOpacities: [0.5],
      channelsFilled: [false],
      channelStrokeWidths: [3],
    });

    if (triggerChanged(initial, cosmetic)) {
      await loadOneTile(cosmetic);
    }

    expect(getTileTrigger(cosmetic)).toEqual(getTileTrigger(initial));
    expect(cosmetic.props.refinementStrategy).toBe(initial.props.refinementStrategy);
    expect(onGetTile).toHaveBeenCalledTimes(1);
  });

  it('treats label selection changes as structural tile-data changes', async () => {
    const { loader, onGetTile } = makeLabelsLoader();
    const initial = renderLabelsLayer({
      loader,
      selections: [{ z: 0, c: 0, t: 0 }],
    });

    await loadOneTile(initial);
    expect(onGetTile).toHaveBeenCalledTimes(1);

    const structural = renderLabelsLayer({
      loader,
      selections: [{ z: 1, c: 0, t: 0 }],
    });

    if (triggerChanged(initial, structural)) {
      await loadOneTile(structural);
    }

    expect(getTileTrigger(structural)).not.toEqual(getTileTrigger(initial));
    expect(onGetTile).toHaveBeenCalledTimes(2);
    expect(onGetTile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selection: { z: 1, c: 0, t: 0 },
      })
    );
  });

  it('passes extension sublayer props through to labels bitmask tiles', () => {
    const { loader } = makeLabelsLoader();
    const tileLayer = renderLabelsLayer({
      loader,
      _subLayerProps: {
        labels: {
          customExtensionProp: 'forwarded',
        },
      },
    });

    const bitmaskLayer = tileLayer.props.renderSubLayers({
      ...tileLayer.props,
      id: 'tile-0-0-0',
      data: {
        data: [new Float32Array([0, 1, 2, 0])],
        width: 2,
        height: 2,
      },
      tile: {
        bbox: { left: 0, top: 0, right: 2, bottom: 2 },
        index: { x: 0, y: 0, z: 0 },
        zoom: 0,
      },
    }) as { props: Record<string, unknown> };

    expect(tileLayer.props.customExtensionProp).toBe('forwarded');
    expect(bitmaskLayer.props.customExtensionProp).toBe('forwarded');
  });

  it('caps minZoom at the deepest resolution level so zoom-out does not stretch labels', () => {
    // deck.gl keeps subdividing past the coarsest real level when minZoom is
    // too negative; getTileData then returns the same clamped data while the
    // tile bbox doubles, stretching labels far beyond the image extent. Capping
    // minZoom at -(levels - 1) (matching Viv) is what prevents that.
    const twoLevel = renderLabelsLayer({ loader: makeLabelsLoader().loader });
    expect(twoLevel.props.minZoom).toBe(-1);
    expect(twoLevel.props.maxZoom).toBe(0);

    const makeScale = () => ({
      shape: [512, 512],
      tileSize: 256,
      getTile: vi.fn(async () => ({ data: new Float32Array([0, 1, 2, 0]), width: 2, height: 2 })),
    });
    const fourLevel = renderLabelsLayer({
      loader: [makeScale(), makeScale(), makeScale(), makeScale()],
    });
    expect(fourLevel.props.minZoom).toBe(-3);
  });

  it('culls tiles whose bbox falls outside the image extent', () => {
    const { loader } = makeLabelsLoader();
    const tileLayer = renderLabelsLayer({ loader });
    const data = {
      data: [new Float32Array([0, 1, 2, 0])],
      width: 2,
      height: 2,
    };

    // A tile that extends past the left/top edge of the image carries negative
    // bbox edges; rendering it produces the wrong-transformation glitch, so it
    // must be culled rather than drawn with garbage bounds.
    const outOfBounds = tileLayer.props.renderSubLayers({
      ...tileLayer.props,
      id: 'labels:mask-viewport-labels',
      data,
      tile: {
        bbox: { left: -256, top: -256, right: 256, bottom: 256 },
        index: { x: -1, y: -1, z: 0 },
        zoom: 0,
      },
    });

    expect(outOfBounds).toBeNull();

    // A tile fully inside the extent still renders.
    const inBounds = tileLayer.props.renderSubLayers({
      ...tileLayer.props,
      id: 'labels:mask-viewport-labels',
      data,
      tile: {
        bbox: { left: 0, top: 0, right: 256, bottom: 256 },
        index: { x: 0, y: 0, z: 0 },
        zoom: 0,
      },
    });

    expect(inBounds).toBeTruthy();
  });

  it('culls tiles with zero-sized data', () => {
    const { loader } = makeLabelsLoader();
    const tileLayer = renderLabelsLayer({ loader });

    const empty = tileLayer.props.renderSubLayers({
      ...tileLayer.props,
      id: 'labels:mask-viewport-labels',
      data: { data: [new Float32Array([])], width: 0, height: 0 },
      tile: {
        bbox: { left: 0, top: 0, right: 256, bottom: 256 },
        index: { x: 0, y: 0, z: 0 },
        zoom: 0,
      },
    });

    expect(empty).toBeNull();
  });

  it('forwards the per-label colour lookup table to bitmask tiles', () => {
    const { loader } = makeLabelsLoader();
    const featureColorLut = buildLabelColorLut({
      featureState: { hiddenFeatureIds: ['2'] },
      defaultColor: [255, 255, 255],
    });
    const tileLayer = renderLabelsLayer({ loader, featureColorLut });

    expect(tileLayer.props.featureColorLut).toBe(featureColorLut);

    const bitmaskLayer = tileLayer.props.renderSubLayers({
      ...tileLayer.props,
      id: 'tile-0-0-0',
      data: { data: [new Float32Array([0, 1, 2, 0])], width: 2, height: 2 },
      tile: {
        bbox: { left: 0, top: 0, right: 2, bottom: 2 },
        index: { x: 0, y: 0, z: 0 },
        zoom: 0,
      },
    }) as { props: Record<string, unknown> };

    expect(bitmaskLayer.props.featureColorLut).toBe(featureColorLut);
  });

  it('forwards the hovered label id to bitmask tiles', () => {
    const { loader } = makeLabelsLoader();
    const tileLayer = renderLabelsLayer({ loader, highlightedLabelId: 2 });

    const bitmaskLayer = tileLayer.props.renderSubLayers({
      ...tileLayer.props,
      id: 'tile-0-0-0',
      data: { data: [new Float32Array([0, 1, 2, 0])], width: 2, height: 2 },
      tile: {
        bbox: { left: 0, top: 0, right: 2, bottom: 2 },
        index: { x: 0, y: 0, z: 0 },
        zoom: 0,
      },
    }) as { props: Record<string, unknown> };

    expect(bitmaskLayer.props.highlightedLabelId).toBe(2);
  });

  it('sends the labels highlight tint down, not deck.gl core’s', () => {
    const { loader } = makeLabelsLoader();
    const tileLayer = renderLabelsLayer({ loader, highlightedLabelId: 2 });

    const bitmaskLayer = tileLayer.props.renderSubLayers({
      ...tileLayer.props,
      id: 'tile-0-0-0',
      data: { data: [new Float32Array([0, 1, 2, 0])], width: 2, height: 2 },
      tile: {
        bbox: { left: 0, top: 0, right: 2, bottom: 2 },
        index: { x: 0, y: 0, z: 0 },
        zoom: 0,
      },
    }) as { props: Record<string, unknown> };

    // The tint lives under `labelHighlightColor` because deck's own `Layer` owns
    // `highlightColor` and defaults it to navy. Naming ours the same made every
    // hover draw in deck's navy: the prop was never absent, so the fallback to
    // yellow below could never run. Assert the value, not just the plumbing.
    expect(bitmaskLayer.props.labelHighlightColor).toEqual(DEFAULT_LABEL_HIGHLIGHT_COLOR);
    expect(bitmaskLayer.props.labelHighlightColor).not.toEqual(DECK_CORE_HIGHLIGHT_COLOR);
  });

  it('does not reload tiles when only the hovered label changes', async () => {
    const { loader, onGetTile } = makeLabelsLoader();
    const initial = renderLabelsLayer({ loader, highlightedLabelId: -1 });

    await loadOneTile(initial);
    expect(onGetTile).toHaveBeenCalledTimes(1);

    // The whole point of carrying hover as a uniform: the pointer moves constantly,
    // and a segmentation's tiles are the most expensive thing on screen to refetch.
    const hovered = renderLabelsLayer({ loader, highlightedLabelId: 7 });
    if (triggerChanged(initial, hovered)) {
      await loadOneTile(hovered);
    }

    expect(getTileTrigger(hovered)).toEqual(getTileTrigger(initial));
    expect(onGetTile).toHaveBeenCalledTimes(1);
  });

  it('does not rebuild the colour table when only the hovered label changes', () => {
    const { loader } = makeLabelsLoader();
    const featureState = { hiddenFeatureIds: ['3'] };
    const initial = renderLabelsLayer({ loader, featureState, highlightedLabelId: -1 });
    const hovered = renderLabelsLayer({ loader, featureState, highlightedLabelId: 2 });

    // Identity, not equality: a fresh table with identical bytes would still be a
    // multi-megabyte texture upload on every pointer move.
    expect(hovered.props.featureColorLut).toBe(initial.props.featureColorLut);
  });

  it('builds a lookup table from serializable featureState when none is supplied', () => {
    const { loader } = makeLabelsLoader();
    const featureState = { hiddenFeatureIds: ['3'] };
    const tileLayer = renderLabelsLayer({ loader, featureState });

    const lut = tileLayer.props.featureColorLut as { count: number; colors: Uint8Array };
    expect(lut.count).toBe(4);
    expect(lut.colors[3 * 4 + 3]).toBe(0);

    // Memoised on the feature-state identity: a re-render with the same state must
    // hand deck the same table, or the layer re-uploads its texture every frame.
    const again = renderLabelsLayer({ loader, featureState });
    expect(again.props.featureColorLut).toBe(lut);
  });

  it('keeps labels bitmask sublayer ids distinct across tile resolutions', () => {
    const { loader } = makeLabelsLoader();
    const tileLayer = renderLabelsLayer({ loader });
    const baseTileProps = {
      ...tileLayer.props,
      id: 'labels:mask-viewport-labels',
      data: {
        data: [new Float32Array([0, 1, 2, 0])],
        width: 2,
        height: 2,
      },
      tile: {
        bbox: { left: 0, top: 0, right: 512, bottom: 512 },
        zoom: 0,
      },
    };

    const highResolutionLayer = tileLayer.props.renderSubLayers({
      ...baseTileProps,
      tile: {
        ...baseTileProps.tile,
        index: { x: 0, y: 0, z: 0 },
      },
    }) as { id: string };
    const lowResolutionLayer = tileLayer.props.renderSubLayers({
      ...baseTileProps,
      tile: {
        ...baseTileProps.tile,
        index: { x: 0, y: 0, z: -1 },
      },
    }) as { id: string };

    expect(highResolutionLayer.id).not.toBe(lowResolutionLayer.id);
  });
});
