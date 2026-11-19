import {
  _LayersPass,
  type EffectContext,
  Layer,
  OrthographicViewport,
  type PickingInfo,
  type PreRenderOptions,
  type Viewport,
} from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { describe, expect, it, vi } from 'vitest';
import {
  GroupIsolationEffect,
  getIsolatedGroupMember,
  getIsolatedGroupMemberId,
  IsolatedGroupLayer,
  type IsolationRenderEvent,
  isIsolatedGroupDescendant,
} from '../src/groups/IsolatedGroupLayer';

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

  it('draws members under group-scoped ids, and resolves picks to the id as given', () => {
    const g = new IsolatedGroupLayer({ id: 'g', layers: [circles('cells')] });
    const drawn = g.renderLayers().flat()[0];
    if (!(drawn instanceof Layer)) throw new Error('expected a member');
    expect(drawn.id).toBe('g/cells');
    drawn.parent = g;

    const info = bubblePick(drawn);
    expect(getIsolatedGroupMember(info)).toBe(drawn);
    expect(getIsolatedGroupMemberId(info)).toBe('cells');
  });

  it('keeps member ids apart when group and member ids contain a slash', () => {
    const drawnIds = (groupId: string, memberId: string) => {
      const g = new IsolatedGroupLayer({ id: groupId, layers: [circles(memberId)] });
      const drawn = g.renderLayers().flat()[0];
      if (!(drawn instanceof Layer)) throw new Error('expected a member');
      drawn.parent = g;
      return { id: drawn.id, memberId: getIsolatedGroupMemberId(bubblePick(drawn)) };
    };

    const one = drawnIds('a', 'b/c');
    const other = drawnIds('a/b', 'c');
    expect(one.id).not.toBe(other.id);
    expect(one.memberId).toBe('b/c');
    expect(other.memberId).toBe('c');
    expect(drawnIds('50%', 'c').memberId).toBe('c');
  });

  it('keeps the innermost record when a pick passes through nested groups', () => {
    const cells = circles('cells');
    const inner = group('inner', [cells]);
    group('outer', [inner]);
    expect(getIsolatedGroupMemberId(bubblePick(cells))).toBe('cells');
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

describe('IsolatedGroupLayer membership', () => {
  it('counts a sublayer whose parent chain runs through earlier instances', () => {
    // deck re-points a sublayer's parent only when its composite re-renders. A member
    // matched with unchanged props keeps sublayers pointing at the previous member,
    // whose parent is the previous group.
    const tile = circles('g/points-tile-3');
    group('g', [circles('g/points')]);
    const oldMember = circles('g/points');
    tile.parent = oldMember;
    group('g', [oldMember]);
    const current = new IsolatedGroupLayer({ id: 'g', layers: [circles('g/points')] });

    expect(isIsolatedGroupDescendant(tile, current)).toBe(true);
    expect(
      isIsolatedGroupDescendant(tile, new IsolatedGroupLayer({ id: 'other', layers: [] }))
    ).toBe(false);
  });
});

describe('GroupIsolationEffect targets', () => {
  type FakeResource = { width?: number; height?: number; destroy: () => void };

  /** A stand-in for the luma device: the effect only creates and frees targets on it. */
  function setUp() {
    const created: FakeResource[] = [];
    const resource = (props: { width?: number; height?: number }) => {
      const r = { width: props.width, height: props.height, destroy: vi.fn() };
      created.push(r);
      return r;
    };
    const device = { createTexture: resource, createFramebuffer: resource };
    const effect = new GroupIsolationEffect();
    // Fakes at the deck/luma boundary: the effect reads only what is stubbed here.
    effect.setup({ device } as unknown as EffectContext);
    vi.spyOn(_LayersPass.prototype, 'render').mockImplementation(() => {});
    const events: IsolationRenderEvent[] = [];
    const layer = new IsolatedGroupLayer({
      id: 'g',
      layers: [],
      onTargetRender: (event) => events.push(event),
    });
    layer.state = { contentsVersion: 0 };
    return { effect, layer, events, created };
  }

  const cell = (id: string, width = 200, x = 0) =>
    new OrthographicViewport({ id, x, width, height: 170, target: [x, 0, 0], zoom: 0 });

  /** One deck pass, as deck draws one `_canvases` canvas: only that canvas's viewports. */
  function pass(
    effect: GroupIsolationEffect,
    layer: IsolatedGroupLayer,
    viewports: Viewport[],
    hidden: string[] = []
  ) {
    const opts = {
      isPicking: false,
      layers: [layer],
      viewports,
      canvasContext: { cssToDeviceRatio: () => 1 },
      layerFilter: ({ viewport }: { viewport: Viewport }) => !hidden.includes(viewport.id),
    };
    // Only the fields the effect reads; the rest go to the mocked pass.
    effect.preRender(opts as unknown as PreRenderOptions);
  }

  const endFrame = () => Promise.resolve();
  const reasons = (events: IsolationRenderEvent[]) => events.map((e) => e.reason);

  it('shares one target between cells on separate canvases', async () => {
    const { effect, layer, events } = setUp();
    for (let frame = 0; frame < 2; frame++) {
      for (const id of ['a', 'b', 'c']) pass(effect, layer, [cell(id)]);
      await endFrame();
    }
    expect(reasons(events)).toEqual(['new']);
  });

  it('keeps targets of different sizes on separate canvases across frames', async () => {
    const { effect, layer, events, created } = setUp();
    for (let frame = 0; frame < 2; frame++) {
      pass(effect, layer, [cell('a')]);
      pass(effect, layer, [cell('b', 160)]);
      await endFrame();
    }
    expect(reasons(events)).toEqual(['new', 'new']);
    expect(created.every((r) => vi.mocked(r.destroy).mock.calls.length === 0)).toBe(true);

    // A pan redraws each size once, into the target it already has.
    pass(effect, layer, [cell('a', 200, 30)]);
    pass(effect, layer, [cell('b', 160, 30)]);
    await endFrame();
    expect(reasons(events)).toEqual(['new', 'new', 'view', 'view']);
  });

  it('redraws for a contents change on a canvas drawn after one that hides the group', async () => {
    const { effect, layer, events } = setUp();
    pass(effect, layer, [cell('hidden')], ['hidden']);
    pass(effect, layer, [cell('b')]);
    await endFrame();
    layer._markContentsChanged();
    pass(effect, layer, [cell('hidden')], ['hidden']);
    pass(effect, layer, [cell('b')]);
    await endFrame();
    expect(reasons(events)).toEqual(['new', 'contents']);
  });

  it('frees a target once a whole frame has passed without it', async () => {
    const { effect, layer, created } = setUp();
    pass(effect, layer, [cell('a')]);
    pass(effect, layer, [cell('b', 160)]);
    await endFrame();
    pass(effect, layer, [cell('a')]);
    await endFrame();
    // A target is a texture and a framebuffer, both freed.
    const freed = (r: FakeResource) => vi.mocked(r.destroy).mock.calls.length > 0;
    expect(created.filter(freed).map((r) => r.width)).toEqual([160, 160]);
    expect(created.filter((r) => r.width === 200).some(freed)).toBe(false);
  });
});
