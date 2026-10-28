import { Matrix4 } from '@math.gl/core';
import type {
  ImageElement,
  LabelsElement,
  ResolveContext,
  ResourceResolver,
  SpatialData,
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

  it('drops a load that outlives dispose instead of reporting it as the live one', async () => {
    // StrictMode's dev double-mount disposes the store mid-load and starts a second
    // load for the same entry. The first one's late "ready" must not be reported:
    // it would flip the entry's status before the live load has data to show.
    let releaseOrphan!: () => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseOrphan = () => resolve(vivLoader())))
      )
      .mockImplementation(async () => vivLoader());
    const onStatus = vi.fn();
    const resolver = new ImagesResolver({ fetchMultiscales: fetch, onStatus });
    const c = imageCtx(imageElement());

    const orphan = resolver.load({ id: 'l', resource: 'loader' }, c, signal());
    resolver.dispose();
    const listener = vi.fn();
    resolver.subscribe(listener);
    onStatus.mockClear();

    releaseOrphan();
    await orphan;

    expect(onStatus).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(resolver.getLoadedData('morphology')).toBeUndefined();
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

  it('plans a fill-colour row load per column, and stops once that column is served', async () => {
    const resolver = new LabelsResolver();

    expect(resolver.plan(labelsCtx(labelsElement())).map((t) => t.resource)).not.toContain(
      'fillColor'
    );

    const withColumn = labelsCtx(labelsElement(), {
      fillColorByColumn: { columnName: 'cell_type', mode: 'auto' },
    });
    const task = resolver.plan(withColumn).find((t) => t.resource === 'fillColor');
    expect(task?.id).toBe('cell_labels#fillColor:cell_type');

    // No spatialData injected, so the association helper returns empty rows —
    // still a settled resource, which is what stops the replan.
    await resolver.load(task as NonNullable<typeof task>, withColumn, signal());
    expect(resolver.getFillColorRows('cell_labels', 'cell_type')).toBeDefined();
    expect(resolver.plan(withColumn).map((t) => t.resource)).not.toContain('fillColor');

    // Switching columns supersedes: the column is part of the task id.
    const otherColumn = labelsCtx(labelsElement(), {
      fillColorByColumn: { columnName: 'area', mode: 'auto' },
    });
    expect(resolver.plan(otherColumn).map((t) => t.id)).toContain('cell_labels#fillColor:area');
  });

  it("holds two layers' columns for one element without evicting each other", async () => {
    // An element-keyed cache made these ping-pong: each plan() saw the other
    // layer's column cached, scheduled a reload, and overwrote it — forever.
    const resolver = new LabelsResolver();
    const byType = labelsCtx(labelsElement(), {
      fillColorByColumn: { columnName: 'cell_type', mode: 'auto' },
    });
    const byArea = labelsCtx(labelsElement(), {
      fillColorByColumn: { columnName: 'area', mode: 'auto' },
    });

    for (const ctx of [byType, byArea]) {
      const task = resolver.plan(ctx).find((t) => t.resource === 'fillColor');
      await resolver.load(task as NonNullable<typeof task>, ctx, signal());
    }

    expect(resolver.getFillColorRows('cell_labels', 'cell_type')).toBeDefined();
    expect(resolver.getFillColorRows('cell_labels', 'area')).toBeDefined();
    // Neither replans: both columns are served, so nothing is reloading anything.
    expect(resolver.plan(byType).map((t) => t.resource)).not.toContain('fillColor');
    expect(resolver.plan(byArea).map((t) => t.resource)).not.toContain('fillColor');
  });
});

describe('LabelsResolver — a table whose instance ids no label can carry', () => {
  // Labels ids live in the raster, so "matches none" cannot be checked without
  // reading pixels. What can be checked for free: whether any table id is even a
  // value the raster's dtype can hold. Packed 64-bit cell ids against a uint32
  // raster (the Atera reader's output) fail that check outright.
  const spatialDataWithTable = (tableIds: string[]) =>
    ({
      getAssociatedTable: () => [
        'table',
        {
          getTableKeys: () => ({
            region: ['cell_labels'],
            regionKey: 'region',
            instanceKey: 'cell_id',
          }),
          loadObsIndex: async () => tableIds,
          loadObsColumns: async (names: string[]) => names.map(() => tableIds.map(() => 'x')),
        },
      ],
    }) as unknown as SpatialData;

  const noticesAfterFillColour = async (tableIds: string[], dtype: string) => {
    const resolver = new LabelsResolver({
      spatialData: spatialDataWithTable(tableIds),
      fetchMultiscales: vi.fn(async () => [{ labels: ['y', 'x'], shape: [64, 64], dtype }]),
    });
    const ctx = labelsCtx(labelsElement(), {
      fillColorByColumn: { columnName: 'cell_type', mode: 'auto' },
    });
    for (const task of resolver.plan(ctx)) await resolver.load(task, ctx, signal());
    return resolver.snapshot(ctx).notices;
  };

  it('raises a notice when no table id fits the label dtype', async () => {
    const notices = await noticesAfterFillColour(['4294992761', '4295003241'], 'Uint32');

    expect(notices).toEqual([
      expect.objectContaining({
        kind: 'table-rows-unmatched',
        tableName: 'table',
        instanceKey: 'cell_id',
      }),
    ]);
    expect(notices[0]?.message).toContain('4294992761');
  });

  it('judges against the raster dtype, not a fixed ceiling', async () => {
    expect(await noticesAfterFillColour(['70000'], 'Uint16')).toHaveLength(1);
    expect(await noticesAfterFillColour(['70000'], 'Uint32')).toEqual([]);
  });

  it('treats non-integer ids as unmatched, and stays quiet when any id could be a label', async () => {
    expect(await noticesAfterFillColour(['aaabbbcc-1', 'aaabbbcd-1'], 'Uint32')).toHaveLength(1);
    expect(await noticesAfterFillColour(['aaabbbcc-1', '17'], 'Uint32')).toEqual([]);
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

  it('store.retry() re-fetches a failed loader once; reconciling alone does not', async () => {
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('the store is unreachable');
      return vivLoader();
    });
    const images = new ImagesResolver({ fetchMultiscales: fetch });
    const store = new SpatialEntryStore({
      points: images as never,
      shapes: images as never,
      images,
      labels: images as never,
    });
    const c = imageCtx(imageElement());

    await store.reconcile([c]);
    await store.reconcile([c]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.snapshot(c)?.resources.loader?.status).toBe('failed');

    await store.retry(c);
    await store.reconcile([c]);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.snapshot(c)?.resources.loader?.status).toBe('ready');
  });

  it('store.retry() re-requests a failed labels tooltip without reloading the raster', async () => {
    const fetch = fetchMultiscales();
    let call = 0;
    // No associated table on the retry: the tooltip settles empty, which is `ready`.
    const getAssociatedTable = vi.fn(() => {
      call += 1;
      if (call === 1) throw new Error('table read failed');
      return undefined;
    });
    const labels = new LabelsResolver({
      fetchMultiscales: fetch,
      spatialData: { getAssociatedTable } as unknown as SpatialData,
    });
    const store = new SpatialEntryStore({
      points: labels as never,
      shapes: labels as never,
      images: labels as never,
      labels,
    });
    const c = labelsCtx(labelsElement(), { tooltipFields: ['cell_type'] });

    await store.reconcile([c]);
    expect(store.snapshot(c)?.resources.tooltip?.status).toBe('failed');

    await store.retry(c);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.snapshot(c)?.resources.tooltip?.status).toBe('ready');
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
