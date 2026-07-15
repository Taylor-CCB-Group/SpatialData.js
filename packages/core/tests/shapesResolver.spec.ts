import { Matrix4 } from '@math.gl/core';
import { describe, expect, it, vi } from 'vitest';
import {
  Resolution,
  type ResolveContext,
  type ShapesResolveConfig,
  ShapesResolver,
} from '../src/engine/index.js';
import type { ShapesElement } from '../src/models/index.js';
import type { ShapesRenderData } from '../src/shapes.js';

/**
 * The shapes Resource Resolver, headless — no deck layer, no GL context.
 *
 * The claim under test that matters most is **per-resource failure**: a shapes
 * entry whose tooltip column is broken must still draw its geometry. That is the
 * whole reason `Resolution` is per-resource and there is no entry-wide `Result`,
 * and it is the thing an entry-wide error channel would quietly get wrong.
 */

const renderData = (over: Partial<ShapesRenderData> = {}): ShapesRenderData => ({
  kind: 'js-polygons',
  geometryKind: 'circle',
  elementKey: 'cells',
  featureIds: ['c1', 'c2'],
  circles: {
    positions: [new Float32Array([0, 10]), new Float32Array([0, 10])],
    radii: new Float32Array([1, 1]),
  },
  rowIndexByFeatureIndex: new Int32Array([0, 1]),
  ...over,
});

function element(over: Record<string, unknown> = {}) {
  return {
    key: 'cells',
    loadRenderData: vi.fn(async () => renderData()),
    loadFeatureIds: vi.fn(async () => ['c1', 'c2']),
    ...over,
  } as unknown as ShapesElement;
}

const ctx = (
  el: ShapesElement,
  config: ShapesResolveConfig = {}
): ResolveContext<ShapesResolveConfig, ShapesElement> => ({
  entryId: 'layer-s',
  elementKey: 'cells',
  kind: 'shapes',
  element: el,
  config,
  transform: new Matrix4(),
});

const signal = () => new AbortController().signal;

describe('plan() — pure, sync, starts nothing', () => {
  it('does not touch the element', () => {
    const el = element();

    new ShapesResolver().plan(ctx(el, { tooltipFields: ['cell_type'] }));

    expect(el.loadRenderData).not.toHaveBeenCalled();
  });

  it('plans geometry for a fresh entry, and nothing else by default', () => {
    const tasks = new ShapesResolver().plan(ctx(element()));

    expect(tasks.map((t) => t.resource)).toEqual(['geometry']);
  });

  it('plans a tooltip only when tooltip fields are configured', () => {
    const resolver = new ShapesResolver();
    const resources = (config: ShapesResolveConfig) =>
      resolver.plan(ctx(element(), config)).map((t) => t.resource);

    expect(resources({})).not.toContain('tooltip');
    expect(resources({ tooltipFields: [] })).not.toContain('tooltip');
    expect(resources({ tooltipFields: ['cell_type'] })).toContain('tooltip');
  });

  it('puts the tooltip-fields signature IN the id, so changing columns supersedes', () => {
    const resolver = new ShapesResolver();

    const a = resolver.plan(ctx(element(), { tooltipFields: ['cell_type'] }))[1];
    const b = resolver.plan(ctx(element(), { tooltipFields: ['cluster'] }))[1];

    expect(a?.id).not.toBe(b?.id);
  });

  it('plans a fill-colour load only when a column is configured', () => {
    const resolver = new ShapesResolver();

    expect(resolver.plan(ctx(element())).map((t) => t.resource)).not.toContain('fillColor');
    expect(
      resolver
        .plan(ctx(element(), { fillColorByColumn: { columnName: 'area', mode: 'numeric' } }))
        .map((t) => t.resource)
    ).toContain('fillColor');
  });

  it('stops planning geometry once it is loaded', async () => {
    const resolver = new ShapesResolver();
    const el = element();

    await resolver.load({ id: 'g', resource: 'geometry' }, ctx(el), signal());

    expect(resolver.plan(ctx(el)).map((t) => t.resource)).toEqual([]);
  });
});

describe('load() — the only place I/O starts', () => {
  it('loads geometry and reports it ready, by reference', async () => {
    const resolver = new ShapesResolver();
    const el = element();

    await resolver.load({ id: 'g', resource: 'geometry' }, ctx(el), signal());

    const snapshot = resolver.snapshot(ctx(el));
    expect(Resolution.isReady(snapshot.resources.geometry as never)).toBe(true);
    expect(Resolution.readyValue(snapshot.resources.geometry as never)).toBe(
      resolver.getRenderData('cells')
    );
  });

  it('dedups a concurrent request for the same task id', async () => {
    const resolver = new ShapesResolver();
    const el = element();
    const task = { id: 'g', resource: 'geometry' };

    await Promise.all([
      resolver.load(task, ctx(el), signal()),
      resolver.load(task, ctx(el), signal()),
    ]);

    expect(el.loadRenderData).toHaveBeenCalledTimes(1);
  });

  it('does not throw on failure — it turns the throw into a value', async () => {
    const resolver = new ShapesResolver();
    const el = element({
      loadRenderData: vi.fn(async () => {
        throw new Error('parquet is corrupt');
      }),
    });

    await expect(
      resolver.load({ id: 'g', resource: 'geometry' }, ctx(el), signal())
    ).resolves.toBeUndefined();

    const geometry = resolver.snapshot(ctx(el)).resources.geometry as never;
    expect(Resolution.isFailed(geometry)).toBe(true);
  });

  it('classifies a geometry failure from the SEAM — a decode, not a generic load', async () => {
    // The throw is a bare Error with no type. `decode-failed` comes from the
    // context's `fallback`, because the seam knows what it was doing.
    const resolver = new ShapesResolver();
    const el = element({
      loadRenderData: vi.fn(async () => {
        throw new Error('something opaque from a codec');
      }),
    });

    await resolver.load({ id: 'g', resource: 'geometry' }, ctx(el), signal());

    const geometry = resolver.snapshot(ctx(el)).resources.geometry;
    if (geometry?.status !== 'failed') throw new Error('narrowing');
    expect(geometry.error.kind).toBe('decode-failed');
    expect(geometry.error.retryable).toBe(true);
  });

  it('restores the prior resolution when an initial load is cancelled — never hangs', async () => {
    // The slot is set to `loading` before the load. A cancelled initial load must
    // fall back to `idle`, or plan() (which only schedules idle geometry) never
    // reschedules it and the entry hangs in loading forever.
    const resolver = new ShapesResolver();
    const el = element({
      loadRenderData: vi.fn(async () => {
        throw new DOMException('Aborted', 'AbortError');
      }),
    });
    const c = ctx(el);

    await resolver.load({ id: 'g', resource: 'geometry' }, c, signal());

    expect(resolver.snapshot(c).resources.geometry?.status).toBe('idle');
    // ...and it is therefore replannable.
    expect(resolver.plan(c).map((t) => t.resource)).toContain('geometry');
  });
});

describe('failure is PER-RESOURCE', () => {
  // The load-bearing claim. An entry-wide Result would get this wrong, and the
  // symptom would be a blank layer where the geometry was perfectly fine.
  it('a broken tooltip does NOT stop the geometry drawing', async () => {
    const resolver = new ShapesResolver();
    const el = element({
      loadFeatureIds: vi.fn(async () => {
        throw new Error('no such column: cell_type');
      }),
    });
    const c = ctx(el, { tooltipFields: ['cell_type'] });

    await resolver.load({ id: 'g', resource: 'geometry' }, c, signal());
    await resolver.load(
      { id: 't', resource: 'tooltip', payload: { tooltipFields: ['cell_type'] } },
      c,
      signal()
    );

    const snapshot = resolver.snapshot(c);
    expect(Resolution.isFailed(snapshot.resources.tooltip as never)).toBe(true);
    // ...and the geometry is untouched and still drawable.
    expect(Resolution.isReady(snapshot.resources.geometry as never)).toBe(true);
    expect(resolver.getRenderData('cells')).toBeDefined();
  });

  it('only geometry blocks a first paint — tooltip and fill colour never have', () => {
    // Today this asymmetry is a kind-switch inside isBlocking. Here it is data.
    expect(new ShapesResolver().blockingResources).toEqual(['geometry']);
  });
});

describe('snapshot() — identity and bounds', () => {
  it('returns the SAME object until something mutates', async () => {
    const resolver = new ShapesResolver();
    const el = element();
    // One ctx, reused — a given entry sees a stable transform across renders (the
    // hook memoises it on [spatialData, coordinateSystem]).
    const c = ctx(el);
    await resolver.load({ id: 'g', resource: 'geometry' }, c, signal());

    const first = resolver.snapshot(c);

    for (let i = 0; i < 10; i++) {
      expect(resolver.snapshot(c)).toBe(first);
    }
  });

  it('gives two layers over one element distinct snapshots', async () => {
    const resolver = new ShapesResolver();
    const el = element();
    await resolver.load({ id: 'g', resource: 'geometry' }, ctx(el), signal());
    const base = ctx(el); // same element, same transform — differ only by entry

    const a = resolver.snapshot({ ...base, entryId: 'layer-a' });
    const b = resolver.snapshot({ ...base, entryId: 'layer-b' });

    expect(a.entryId).toBe('layer-a');
    expect(b.entryId).toBe('layer-b');
    expect(a).not.toBe(b);
  });

  it('recomputes bounds when the transform changes (a new coordinate system)', async () => {
    // Bounds are world-space. Reuse the same geometry under a new Matrix4 and the
    // old bounds would be wrong — so the transform is part of the snapshot key.
    const resolver = new ShapesResolver();
    const el = element();
    await resolver.load({ id: 'g', resource: 'geometry' }, ctx(el), signal());

    const identity = resolver.snapshot({ ...ctx(el), transform: new Matrix4() });
    const scaled = resolver.snapshot({ ...ctx(el), transform: new Matrix4().scale(2) });

    expect(scaled).not.toBe(identity);
    // Circles at (0,0),(10,10) r=1 → [-1,11]; scaled ×2 → [-2,22].
    expect(scaled.bounds).toMatchObject({ minX: -2, maxX: 22 });
  });

  it('computes world bounds from the geometry once loaded', async () => {
    const resolver = new ShapesResolver();
    const el = element();

    expect(resolver.snapshot(ctx(el)).bounds).toBeNull();

    await resolver.load({ id: 'g', resource: 'geometry' }, ctx(el), signal());

    // Circles at (0,0) and (10,10), radius 1 → [-1, -1] .. [11, 11].
    expect(resolver.snapshot(ctx(el)).bounds).toMatchObject({
      minX: -1,
      minY: -1,
      maxX: 11,
      maxY: 11,
    });
  });

  it('retains the last good geometry across a failed reload — stale keeps drawing', async () => {
    const resolver = new ShapesResolver();
    let call = 0;
    const el = element({
      loadRenderData: vi.fn(async () => {
        call += 1;
        if (call === 1) return renderData();
        throw new Error('the second read failed');
      }),
    });
    const c = ctx(el);

    await resolver.load({ id: 'g1', resource: 'geometry' }, c, signal());
    const good = resolver.getRenderData('cells');

    await resolver.load({ id: 'g2', resource: 'geometry' }, c, signal());

    const geometry = resolver.snapshot(c).resources.geometry as never;
    expect(Resolution.isFailed(geometry)).toBe(true);
    // "stale is a retention": the failed refine keeps drawing rather than blanking.
    expect(Resolution.lastGood(geometry)).toBe(good);
  });
});
