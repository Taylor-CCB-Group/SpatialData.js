/**
 * Shapes must still load when the parquet worker lets go mid-request.
 *
 * `decodeShapesGeometryInWorker` returning `null` — the worker was never enabled —
 * has always fallen through to the main-thread decode. A *rejection* is the other
 * half of the same story, and it did not: a request timeout, a worker that died,
 * or one that failed to start between the enabled check and the post all
 * propagated out of `loadShapesRenderData`, so an element that was merely slow to
 * decode failed to load at all.
 */
import type { Vector } from 'apache-arrow/vector';
import WKB from 'ol/format/WKB.js';
import Polygon from 'ol/geom/Polygon.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const decodeShapesGeometryInWorker = vi.hoisted(() => vi.fn());
const isParquetWorkerEnabled = vi.hoisted(() => vi.fn(() => true));

vi.mock('../src/workers/index.js', () => ({
  decodeShapesGeometryInWorker,
  ensureParquetWorker: vi.fn(),
  isParquetWorkerEnabled,
}));

const { default: SpatialDataShapesSource } = await import('../src/models/VShapesSource.js');

function toBytes(written: string | Uint8Array): Uint8Array {
  if (written instanceof Uint8Array) {
    return written;
  }
  const bytes = new Uint8Array(written.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(written.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** A parquet table with one real WKB geometry column, as the main-thread decode wants it. */
function tableWithSquare() {
  const square = new Polygon([
    [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ],
  ]);
  const column = {
    type: { toString: () => 'Binary' },
    toArray: () => [toBytes(new WKB().writeGeometry(square))],
  } as unknown as Vector;
  return {
    numRows: 1,
    schema: { fields: [{ name: 'geometry' }], metadata: new Map() },
    getChild: (name: string) => (name === 'geometry' ? column : undefined),
  };
}

function sourceWithParquet() {
  const source = new SpatialDataShapesSource({ store: {} as never, fileType: '.zarr' });
  vi.spyOn(source, 'getShapesFormatVersion').mockResolvedValue('0.2');
  vi.spyOn(source, 'loadShapesIndex').mockResolvedValue(['cell-1']);
  vi.spyOn(source, 'loadParquetTable').mockResolvedValue(tableWithSquare() as never);
  vi.spyOn(source as never as { loadParquetBytes: () => unknown }, 'loadParquetBytes')
    // Non-empty, so the worker branch is actually entered.
    .mockResolvedValue(new Uint8Array([1, 2, 3]));
  return source;
}

describe('shapes geometry decode when the worker fails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isParquetWorkerEnabled.mockReturnValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('falls back to the main thread when the worker rejects', async () => {
    // What core throws at a caller when a worker dies after the request was posted.
    decodeShapesGeometryInWorker.mockRejectedValue(
      new Error('Parquet worker failed to start (Failed to fetch worker)')
    );
    const source = sourceWithParquet();

    const renderData = await source.loadShapesRenderData('shapes/cells');

    expect(renderData).toMatchObject({ geometryKind: 'polygon', featureIds: ['cell-1'] });
    expect(source.loadParquetTable).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to main thread'),
      expect.any(Error)
    );
  });

  it('falls back when a slow decode trips the request timeout', async () => {
    decodeShapesGeometryInWorker.mockRejectedValue(
      new Error('Parquet worker did not respond within 30000ms; falling back to the main thread')
    );
    const source = sourceWithParquet();

    await expect(source.loadShapesRenderData('shapes/cells')).resolves.toMatchObject({
      geometryKind: 'polygon',
    });
  });

  it('still uses the worker result when the worker answers', async () => {
    // A triangle, so the result cannot be confused with the square the
    // main-thread decode would produce from the fixture table.
    decodeShapesGeometryInWorker.mockResolvedValue({
      kind: 'polygon',
      positions: new Float32Array([0, 0, 1, 0, 1, 1]),
      startIndices: new Int32Array([0, 3]),
      featureCount: 1,
    });
    const source = sourceWithParquet();

    await expect(source.loadShapesRenderData('shapes/cells')).resolves.toMatchObject({
      polygonBinary: { startIndices: new Int32Array([0, 3]) },
    });
    expect(console.warn).not.toHaveBeenCalled();
  });
});
