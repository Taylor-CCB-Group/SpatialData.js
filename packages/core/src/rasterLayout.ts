import { getArrayMetadata, getChildNode, type ZarrTree } from 'zarrextra';
import type { Remedy } from './issues.js';

/**
 * Flags image/labels layouts that are slow however well the client behaves.
 *
 * - **No usable pyramid.** Channel stats, the histogram and the zoomed-out view read the
 *   coarsest level; if that is large, every channel load scans all of it.
 * - **Oversized chunks.** A tile decodes every chunk it touches; if one chunk of the
 *   finest level decodes to a lot, tiles do far more work than they show and few chunks
 *   fit in the chunk cache.
 *
 * Only array metadata (`zarr.json` / `.zarray`) is read, never pixels.
 */

/** Coarsest-level plane size (pixels) above which stats and overview rendering get slow. */
export const COARSEST_LEVEL_PIXEL_BUDGET = 2048 * 2048;
/** Decoded size of one finest-level chunk above which tiles do far more work than they show. */
export const CHUNK_DECODED_BYTES_BUDGET = 16 * 1024 * 1024;

export type RasterLayoutBudgets = {
  coarsestLevelPixels: number;
  chunkDecodedBytes: number;
};

export const DEFAULT_RASTER_LAYOUT_BUDGETS: RasterLayoutBudgets = {
  coarsestLevelPixels: COARSEST_LEVEL_PIXEL_BUDGET,
  chunkDecodedBytes: CHUNK_DECODED_BYTES_BUDGET,
};

export type RasterLevelInfo = {
  path: string;
  shape: number[];
  /** Inner (decode-unit) chunk shape: the sharding codec's inner chunks when sharded. */
  chunks: number[];
  bytesPerElement: number;
};

export type RasterLayoutIssue = (
  | { kind: 'no-pyramid'; width: number; height: number }
  | { kind: 'coarsest-level-large'; levels: number; width: number; height: number }
  | { kind: 'oversized-chunks'; chunkWidth: number; chunkHeight: number; decodedBytes: number }
) & { remedy: Remedy };

const BUILD_PYRAMID: Remedy = {
  op: 'build-pyramid',
  factor: 2,
  coarsestAtMostPixels: 2048,
};

const product = (values: number[]) => values.reduce((a, b) => a * b, 1);

/** OME-NGFF puts spatial axes last, so y and x are the final two dimensions. */
function planeSize(shape: number[]) {
  return { height: shape.at(-2) ?? 1, width: shape.at(-1) ?? 1 };
}

/** @param levels finest first, as listed in the multiscales. */
export function assessRasterLevels(
  levels: readonly RasterLevelInfo[],
  budgets: RasterLayoutBudgets = DEFAULT_RASTER_LAYOUT_BUDGETS
): RasterLayoutIssue[] {
  const finest = levels[0];
  const coarsest = levels[levels.length - 1];
  if (!finest || !coarsest) return [];
  const issues: RasterLayoutIssue[] = [];
  const { width, height } = planeSize(coarsest.shape);
  if (width * height > budgets.coarsestLevelPixels) {
    issues.push(
      levels.length === 1
        ? { kind: 'no-pyramid', width, height, remedy: BUILD_PYRAMID }
        : {
            kind: 'coarsest-level-large',
            levels: levels.length,
            width,
            height,
            remedy: BUILD_PYRAMID,
          }
    );
  }
  const decodedBytes = product(finest.chunks) * finest.bytesPerElement;
  if (decodedBytes > budgets.chunkDecodedBytes) {
    const chunk = planeSize(finest.chunks);
    issues.push({
      kind: 'oversized-chunks',
      chunkWidth: chunk.width,
      chunkHeight: chunk.height,
      decodedBytes,
      remedy: {
        op: 'rechunk',
        chunkPixels: { min: 512, max: 1024 },
        decodedBytesAtMost: budgets.chunkDecodedBytes,
      },
    });
  }
  return issues;
}

const megapixels = (width: number, height: number) => `${((width * height) / 1e6).toFixed(1)} MP`;
const mebibytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

export function describeRasterLayoutIssue(issue: RasterLayoutIssue): string {
  switch (issue.kind) {
    case 'no-pyramid':
      return `No resolution pyramid: a single ${issue.width}×${issue.height} level (${megapixels(issue.width, issue.height)}). Channel stats and the zoomed-out view read every pixel.`;
    case 'coarsest-level-large':
      return `Pyramid stops too early: the coarsest of ${issue.levels} levels is ${issue.width}×${issue.height} (${megapixels(issue.width, issue.height)}). Channel stats and the zoomed-out view read all of it.`;
    case 'oversized-chunks':
      return `Chunks are ${issue.chunkWidth}×${issue.chunkHeight} (${mebibytes(issue.decodedBytes)} decoded each), so every tile decodes far more than it shows.`;
  }
}

const V2_DTYPE_BYTES = /^[<>|][a-z](\d+)$/;
const V3_DTYPE_BYTES: Record<string, number> = {
  bool: 1,
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  float16: 2,
  int32: 4,
  uint32: 4,
  float32: 4,
  int64: 8,
  uint64: 8,
  float64: 8,
};

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'number');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Shape, inner chunk shape and element size from a v3 `zarr.json` or v2 `.zarray`. */
export function parseArrayMetadata(path: string, meta: unknown): RasterLevelInfo | null {
  if (!isRecord(meta) || !isNumberArray(meta.shape)) return null;
  // v2
  if (isNumberArray(meta.chunks) && typeof meta.dtype === 'string') {
    const bytes = V2_DTYPE_BYTES.exec(meta.dtype)?.[1];
    if (!bytes) return null;
    return { path, shape: meta.shape, chunks: meta.chunks, bytesPerElement: Number(bytes) };
  }
  // v3
  if (typeof meta.data_type !== 'string') return null;
  const bytesPerElement = V3_DTYPE_BYTES[meta.data_type];
  const grid =
    isRecord(meta.chunk_grid) && isRecord(meta.chunk_grid.configuration)
      ? meta.chunk_grid.configuration
      : null;
  if (!bytesPerElement || !grid || !isNumberArray(grid.chunk_shape)) return null;
  let chunks = grid.chunk_shape;
  // A sharded array's grid chunk is the shard; the inner chunk is what gets decoded.
  const codecs = Array.isArray(meta.codecs) ? meta.codecs : [];
  for (const codec of codecs) {
    if (
      isRecord(codec) &&
      codec.name === 'sharding_indexed' &&
      isRecord(codec.configuration) &&
      isNumberArray(codec.configuration.chunk_shape)
    ) {
      chunks = codec.configuration.chunk_shape;
    }
  }
  return { path, shape: meta.shape, chunks, bytesPerElement };
}

/**
 * Array metadata for each level of a raster element, finest first, read from the
 * consolidated tree. Levels whose metadata can't be parsed are skipped.
 */
export function rasterLevelsFromTree(
  element: ZarrTree,
  scaleLevels: readonly string[]
): RasterLevelInfo[] {
  const levels: RasterLevelInfo[] = [];
  for (const path of scaleLevels) {
    const info = parseArrayMetadata(path, getArrayMetadata(getChildNode(element, path)));
    if (info) levels.push(info);
  }
  return levels;
}
