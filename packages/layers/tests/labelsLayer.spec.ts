import { describe, expect, it, vi } from 'vitest';
import { LabelsLayer } from '../src/LabelsLayer';
import type { LabelsLayerProps } from '../src/LabelsLayer';

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
    getTile: vi.fn(
      async ({
        x,
        y,
        selection,
      }: {
        x: number;
        y: number;
        selection: unknown;
      }) => {
        onGetTile({ resolution, x, y, selection });
        return {
          data: new Float32Array([0, 1, 2, 0]),
          width: 2,
          height: 2,
        };
      }
    ),
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
});
