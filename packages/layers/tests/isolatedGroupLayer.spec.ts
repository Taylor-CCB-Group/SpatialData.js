import type { Layer, PickingInfo } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { describe, expect, it, vi } from 'vitest';
import { getIsolatedGroupMember, IsolatedGroupLayer } from '../src/groups/IsolatedGroupLayer';

function circles(id: string): ScatterplotLayer {
  return new ScatterplotLayer({ id, data: [{}], getPosition: [0, 0] });
}

function group(id: string, layers: Layer[]): IsolatedGroupLayer {
  const layer = new IsolatedGroupLayer({ id, layers });
  // LayerManager sets parents when it renders the group; there is no manager here.
  for (const child of layers) child.parent = layer;
  return layer;
}

/**
 * deck's `getLayerPickingInfo` (@deck.gl/core lib/picking/pick-info): from the picked
 * layer up through each parent, set `info.layer` to the current layer and pass the
 * layer below as `sourceLayer`. deck does not export it, so it is mirrored here.
 */
function bubblePick(picked: Layer, isPicked = true): PickingInfo {
  let info: PickingInfo = {
    color: null,
    layer: null,
    index: isPicked ? 0 : -1,
    picked: isPicked,
    x: 0,
    y: 0,
    pixelRatio: 1,
  };
  for (let layer: Layer | null = picked; layer; layer = layer.parent) {
    const sourceLayer = info.layer;
    info.sourceLayer = sourceLayer;
    info.layer = layer;
    info = layer.getPickingInfo({ info, mode: 'hover', sourceLayer });
  }
  return info;
}

describe('IsolatedGroupLayer picking', () => {
  it('records nothing for a pick outside any group', () => {
    const info = bubblePick(circles('cells'));
    expect(info.layer?.id).toBe('cells');
    expect(getIsolatedGroupMember(info)).toBeNull();
  });

  it('names the member a pick came through, while deck names the group', () => {
    const cells = circles('cells');
    group('g', [circles('nuclei'), cells]);
    const info = bubblePick(cells);
    expect(info.layer?.id).toBe('g');
    expect(getIsolatedGroupMember(info)).toBe(cells);
  });

  it('looks through nested groups to the innermost member', () => {
    const cells = circles('cells');
    const inner = group('inner', [cells]);
    group('outer', [inner]);
    const info = bubblePick(cells);
    expect(info.layer?.id).toBe('outer');
    expect(getIsolatedGroupMember(info)).toBe(cells);
  });

  it('names the member, not the sublayer, when the member is a composite', () => {
    const entry = circles('points');
    const tile = circles('points-tile-3');
    tile.parent = entry;
    group('g', [entry]);
    expect(getIsolatedGroupMember(bubblePick(tile))).toBe(entry);
  });

  it('hands hover highlighting to the picked member only', () => {
    const red = circles('red');
    const green = circles('green');
    const g = group('g', [red, green]);
    const toRed = vi.spyOn(red, 'updateAutoHighlight').mockImplementation(() => {});
    const toGreen = vi.spyOn(green, 'updateAutoHighlight').mockImplementation(() => {});

    const info = bubblePick(green);
    g.updateAutoHighlight(info);
    expect(toGreen).toHaveBeenCalledWith(info);
    // Both share object index 0, so forwarding to the sibling would light it up too.
    expect(toRed).not.toHaveBeenCalled();

    // Moving off: deck re-walks the last picked layer with `picked: false` to clear it.
    const cleared = bubblePick(green, false);
    g.updateAutoHighlight(cleared);
    expect(toGreen).toHaveBeenLastCalledWith(cleared);
    expect(toRed).not.toHaveBeenCalled();
  });
});
