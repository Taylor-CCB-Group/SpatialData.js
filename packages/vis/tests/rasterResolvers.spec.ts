import { Matrix4 } from '@math.gl/core';
import type {
  ImageElement,
  LabelsElement,
  ResolveContext,
  ResourceResolver,
} from '@spatialdata/core';
import { Resolution, SpatialEntryStore } from '@spatialdata/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type ImagesResolveConfig,
  ImagesResolver,
  type LabelsResolveConfig,
  LabelsResolver,
} from '../src/SpatialCanvas/resolvers/RasterResolvers.js';

/**
 * The images and labels resolvers — which live in `vis`, not `core`.
 *
 * The claim under test is the one that makes that placement safe: **they satisfy
 * the same `ResourceResolver` interface**, and the store cannot tell they came
 * from a different package. Placement is per-kind and driven by dependency; it is
 * not a licence for images to be special.
 *
 * If a `vis`-resident resolver ever needs something the interface doesn't offer,
 * that is a signal about the interface — and these tests are where it would first
 * show up as friction.
 */

const vivLoader = () => [{ labels: ['y', 'x'], shape: [64, 64], dtype: 'uint16' }];

const imageElement = (over: Record<string, unknown> = {}) =>
  ({
    key: 'morphology',
    path: 'images/morphology',
    attrs: {},
    getStore: () => ({}),
    ...over,
  }) as unknown as ImageElement;

const labelsElement = (over: Record<string, unknown> = {}) =>
  ({
    key: 'cell_labels',
    path: 'labels/cells',
    attrs: {},
    getStore: () => ({}),
    ...over,
  }) as unknown as LabelsElement;

const imageCtx = (
  el: ImageElement,
  config: ImagesResolveConfig = {}
): ResolveContext<ImagesResolveConfig, ImageElement> => ({
  entryId: 'layer-i',
  elementKey: 'morphology',
  kind: 'images',
  element: el,
  config,
  transform: new Matrix4(),
});

const labelsCtx = (
  el: LabelsElement,
  config: LabelsResolveConfig = {}
): ResolveContext<LabelsResolveConfig, LabelsElement> => ({
  entryId: 'layer-l',
  elementKey: 'cell_labels',
  kind: 'labels',
  element: el,
  config,
  transform: new Matrix4(),
});

const signal = () => new AbortController().signal;

/** Injected in place of the real OME-Zarr multiscales fetch. This IS the DI seam
 * ADR 0004 §6 mistakenly believed did not exist — createImageLoader has always
 * taken it as a parameter. */
const fetchMultiscales = () => vi.fn(async () => vivLoader());

describe('ImagesResolver — a ResourceResolver that happens to live in vis', () => {
  it('is structurally a ResourceResolver', () => {
    // The type assertion is the test: if the vis-resident resolvers drifted from
    // core's interface, this would not compile.
    const resolver: ResourceResolver<ImagesResolveConfig, ImageElement> = new ImagesResolver();

    expect(resolver.kind).toBe('images');
    expect(resolver.blockingResources).toEqual(['loader']);
  });

  it('plan() is pure — it does not fetch', () => {
    const fetch = fetchMultiscales();

    new ImagesResolver({ fetchMultiscales: fetch }).plan(imageCtx(imageElement()));

    expect(fetch).not.toHaveBeenCalled();
  });

  it('loads through the INJECTED fetcher — no React context, no port', async () => {
    const fetch = fetchMultiscales();
    const resolver = new ImagesResolver({ fetchMultiscales: fetch });
    const el = imageElement();

    await resolver.load({ id: 'l', resource: 'loader' }, imageCtx(el), signal());

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Resolution.isReady(resolver.snapshot(imageCtx(el)).resources.loader as never)).toBe(
      true
    );
  });

  it('computes channel defaults with no omero metadata (the per-channel fallback)', async () => {
    const resolver = new ImagesResolver({ fetchMultiscales: fetchMultiscales() });
    const el = imageElement();

    await resolver.load({ id: 'l', resource: 'loader' }, imageCtx(el), signal());

    const data = resolver.getLoadedData('morphology');
    expect(data?.colors).toBeDefined();
    expect(data?.contrastLimits).toBeDefined();
    expect(data?.channelsVisible).toBeDefined();
    // uint16 with no omero → the per-channel fallback's max value.
    expect(data?.contrastLimits?.[0]).toEqual([0, 65535]);
  });

  it('turns a loader failure into a value, not a throw', async () => {
    const resolver = new ImagesResolver({
      fetchMultiscales: vi.fn(async () => {
        throw new Error('the store is unreachable');
      }),
    });
    const el = imageElement();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      resolver.load({ id: 'l', resource: 'loader' }, imageCtx(el), signal())
    ).resolves.toBeUndefined();

    const loader = resolver.snapshot(imageCtx(el)).resources.loader;
    if (loader?.status !== 'failed') throw new Error('narrowing');
    expect(loader.error.kind).toBe('load-failed');
    expect(loader.error.retryable).toBe(true);
  });

  it('stops planning once loaded', async () => {
    const resolver = new ImagesResolver({ fetchMultiscales: fetchMultiscales() });
    const el = imageElement();

    await resolver.load({ id: 'l', resource: 'loader' }, imageCtx(el), signal());

    expect(resolver.plan(imageCtx(el))).toEqual([]);
  });

  it('snapshot is identity-stable between mutations', async () => {
    const resolver = new ImagesResolver({ fetchMultiscales: fetchMultiscales() });
    const el = imageElement();
    // One ctx, reused — a given entry sees a stable transform across renders.
    const c = imageCtx(el);
    await resolver.load({ id: 'l', resource: 'loader' }, c, signal());

    const first = resolver.snapshot(c);

    for (let i = 0; i < 5; i++) expect(resolver.snapshot(c)).toBe(first);
  });

  it('restores the prior resolution when an initial load is cancelled', async () => {
    // Without the restore, plan() (which only schedules an idle loader) would never
    // reschedule and the entry would hang in `loading` forever.
    const resolver = new ImagesResolver({
      fetchMultiscales: vi.fn(async () => {
        throw new DOMException('Aborted', 'AbortError');
      }),
    });
    const el = imageElement();
    const c = imageCtx(el);

    await resolver.load({ id: 'l', resource: 'loader' }, c, signal());

    // Back to idle, not stuck loading — and therefore replannable.
    expect(resolver.snapshot(c).resources.loader?.status).toBe('idle');
    expect(resolver.plan(c).map((t) => t.resource)).toEqual(['loader']);
  });

  it('surfaces a channel-defaults failure as a NOTICE, not a failed loader', async () => {
    // Computing contrast stats reads pixels and can fail on a store whose metadata
    // loaded fine. The image still draws with fallback channels, so it is a notice.
    const resolver = new ImagesResolver({
      // A loader with omero channels forces the stats path, which we make throw.
      fetchMultiscales: vi.fn(async () => [{ labels: ['c', 'y', 'x'], shape: [2, 64, 64] }]),
    });
    const el = imageElement({
      attrs: { omero: { channels: [{ label: 'DAPI' }, { label: 'GFP' }] } },
    });
    const c = imageCtx(el);

    await resolver.load({ id: 'l', resource: 'loader' }, c, signal());

    const snapshot = resolver.snapshot(c);
    // The loader itself is ready — the image draws.
    expect(snapshot.resources.loader?.status).toBe('ready');
    // ...and the failure is recorded, not swallowed.
    expect(snapshot.notices).toEqual([
      expect.objectContaining({ kind: 'channel-defaults-fallback' }),
    ]);
  });

  it('recomputes bounds when the transform changes', async () => {
    const resolver = new ImagesResolver({ fetchMultiscales: fetchMultiscales() });
    const el = imageElement();
    await resolver.load({ id: 'l', resource: 'loader' }, imageCtx(el), signal());

    const a = resolver.snapshot({ ...imageCtx(el), transform: new Matrix4() });
    const b = resolver.snapshot({ ...imageCtx(el), transform: new Matrix4().scale(2) });

    expect(b).not.toBe(a);
  });
});

describe('LabelsResolver', () => {
  it('is structurally a ResourceResolver', () => {
    const resolver: ResourceResolver<LabelsResolveConfig, LabelsElement> = new LabelsResolver();

    expect(resolver.kind).toBe('labels');
  });

  it('builds the seven-array labels channel defaults', async () => {
    // Labels carry SEVEN channel arrays where images carry four — which is why
    // avivatorish's mergeLayerChannelState does not cover them, and why the ladder
    // is hand-written in two places today.
    const resolver = new LabelsResolver({ fetchMultiscales: fetchMultiscales() });
    const el = labelsElement();

    await resolver.load({ id: 'l', resource: 'loader' }, labelsCtx(el), signal());

    const data = resolver.getLoadedData('cell_labels');
    // The loader exposes labels/shape, so this takes the metadata branch: with no
    // omero colour it falls to COLOR_PALLETE[0], NOT the bare white default. (White
    // is only what you get when the loader tells us nothing at all.)
    expect(data?.colors).toEqual([[0, 0, 255]]);
    expect(data?.channelsVisible).toEqual([true]);
    // The characteristic labels look: faint fill, strong outline.
    expect(data?.channelOpacities).toEqual([0.18]);
    expect(data?.channelOutlineOpacities).toEqual([0.95]);
    expect(data?.channelsFilled).toEqual([true]);
    expect(data?.channelStrokeWidths).toEqual([1.5]);
    expect(data?.selections).toBeDefined();
  });

  it('falls back to white when the loader exposes no metadata at all', async () => {
    const resolver = new LabelsResolver({ fetchMultiscales: vi.fn(async () => ({})) });
    const el = labelsElement();

    await resolver.load({ id: 'l', resource: 'loader' }, labelsCtx(el), signal());

    expect(resolver.getLoadedData('cell_labels')?.colors).toEqual([[255, 255, 255]]);
  });

  it('plans a tooltip only when fields are configured', () => {
    const resolver = new LabelsResolver();

    expect(resolver.plan(labelsCtx(labelsElement())).map((t) => t.resource)).toEqual(['loader']);
    expect(
      resolver
        .plan(labelsCtx(labelsElement(), { tooltipFields: ['region'] }))
        .map((t) => t.resource)
    ).toContain('tooltip');
  });
});

describe('the store cannot tell where a resolver lives', () => {
  // The whole safety argument for placement-by-dependency. If the store could
  // distinguish a vis-resident resolver from a core-resident one, "images is
  // special" would become representable — and that is how one interface quietly
  // becomes two.
  it('registers vis-resident resolvers through the same core registry', async () => {
    const images = new ImagesResolver({ fetchMultiscales: fetchMultiscales() });
    const labels = new LabelsResolver({ fetchMultiscales: fetchMultiscales() });

    const store = new SpatialEntryStore({
      points: images as never, // not exercised here
      shapes: images as never,
      images,
      labels,
    });

    const el = imageElement();
    await store.reconcile([imageCtx(el)]);

    expect(store.snapshot(imageCtx(el))?.resources.loader?.status).toBe('ready');
    expect(store.isBlocking(imageCtx(el))).toBe(false);
  });

  it('blocks on the raster loader until it is drawable', async () => {
    const images = new ImagesResolver({ fetchMultiscales: fetchMultiscales() });
    const store = new SpatialEntryStore({
      points: images as never,
      shapes: images as never,
      images,
      labels: images as never,
    });
    const el = imageElement();

    expect(store.isBlocking(imageCtx(el))).toBe(true);

    await store.reconcile([imageCtx(el)]);

    expect(store.isBlocking(imageCtx(el))).toBe(false);
  });
});
