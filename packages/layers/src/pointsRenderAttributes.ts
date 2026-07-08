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

interface CacheEntry extends PointsRenderAttributes {
  use3d: boolean;
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

  const entry: CacheEntry = { length, positions, featureCodes, use3d };
  cache.set(batch, entry);
  return entry;
}
