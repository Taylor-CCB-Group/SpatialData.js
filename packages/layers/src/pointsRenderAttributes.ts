import type { ColumnarNdarrayPointsBatch } from './pointsLoader.js';

/**
 * GPU-ready binary attributes for a points batch, replacing deck's per-object
 * `getPosition`/`getFeatureCode` accessors (see deck.gl performance guide:
 * https://deck.gl/docs/developer-guide/performance#optimize-accessors).
 *
 * `positions` is interleaved `[x, y, z, x, y, z, …]`; `featureCodes` is one
 * float per point. Both are built once per batch and memoized on the batch
 * identity, so a stable batch (e.g. the cached filtered result) hands deck the
 * same buffer every render — no re-upload, no per-frame CPU pass.
 *
 * This is the seam where worker-emitted interleaved buffers will slot in when
 * streaming lands: the worker produces these arrays directly and the batch
 * carries them, making {@link buildPointsAttributes} a pass-through.
 */
export interface PointsRenderAttributes {
  length: number;
  positions: Float32Array;
  /** Per-point feature code as float; `undefined` when the batch has no codes. */
  featureCodes?: Float32Array;
}

/**
 * The `data` prop handed to deck: a length plus binary attribute descriptors.
 *
 * Deck compares `props.data` BY IDENTITY. A fresh object here — even one wrapping
 * the very same buffers — sets `dataChanged` and invalidates every attribute, so
 * the whole position buffer is re-uploaded. Memoizing the buffers is not enough;
 * the wrapper has to be stable too.
 */
export interface PointsDeckData {
  length: number;
  attributes: {
    getPosition: { value: Float32Array; size: number };
    getFeatureCode?: { value: Float32Array; size: number };
  };
}

interface CacheEntry extends PointsRenderAttributes {
  use3d: boolean;
  /** Memoized `data` wrappers, one per colour mode (the attribute set differs). */
  deckData: { colored?: PointsDeckData; plain?: PointsDeckData };
}

const cache = new WeakMap<ColumnarNdarrayPointsBatch, CacheEntry>();

function pointCountOf(batch: ColumnarNdarrayPointsBatch): number {
  const fromShape = batch.pointCount ?? batch.shape[1];
  const fromData = batch.data[0]?.length ?? 0;
  if (typeof fromShape === 'number' && Number.isFinite(fromShape)) {
    return Math.min(fromShape, fromData);
  }
  return fromData;
}

export function buildPointsAttributes(
  batch: ColumnarNdarrayPointsBatch,
  use3d: boolean
): PointsRenderAttributes {
  const cached = cache.get(batch);
  if (cached && cached.use3d === use3d) {
    return cached;
  }

  const length = pointCountOf(batch);
  const xs = batch.data[0];
  const ys = batch.data[1];
  const zs = batch.data[2];
  const positions = new Float32Array(length * 3);
  for (let i = 0; i < length; i += 1) {
    positions[i * 3] = xs[i];
    positions[i * 3 + 1] = ys[i];
    positions[i * 3 + 2] = use3d && zs ? zs[i] || 0 : 0;
  }

  let featureCodes: Float32Array | undefined;
  const codes = batch.featureCodes;
  if (codes && codes.length >= length) {
    featureCodes = codes instanceof Float32Array ? codes : Float32Array.from(codes);
  }

  const entry: CacheEntry = { length, positions, featureCodes, use3d, deckData: {} };
  cache.set(batch, entry);
  return entry;
}

/**
 * The deck `data` prop for a batch — the SAME object on every call for a given
 * (batch, use3d, colorByFeature).
 *
 * Rebuilding it per render made deck treat the layer's data as new and re-upload
 * every binary attribute, so an unrelated prop change (point size, opacity, a
 * hover) cost a full position re-upload: ~80ms of `bufferSubData` for a 3.7M-point
 * element, ~44MB of positions. Neither `getRadius` vs `radiusScale` nor the
 * `updateTriggers` entry mattered, because `dataChanged` invalidates everything
 * regardless of triggers.
 */
export function buildPointsDeckData(
  batch: ColumnarNdarrayPointsBatch,
  use3d: boolean,
  colorByFeature: boolean
): PointsDeckData {
  const attributes = buildPointsAttributes(batch, use3d);
  const entry = cache.get(batch);
  const codes = colorByFeature ? attributes.featureCodes : undefined;
  const slot = codes ? 'colored' : 'plain';
  const cached = entry?.deckData[slot];
  if (cached) {
    return cached;
  }
  const data: PointsDeckData = {
    length: attributes.length,
    attributes: {
      getPosition: { value: attributes.positions, size: 3 },
      ...(codes ? { getFeatureCode: { value: codes, size: 1 } } : {}),
    },
  };
  if (entry) {
    entry.deckData[slot] = data;
  }
  return data;
}
