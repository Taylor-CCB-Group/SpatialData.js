import { enableParquetWorker, isParquetWorkerEnabled } from '@spatialdata/core';
// The documented consumer recipe. This import is what makes the worker's own bundle
// — including the parquet-wasm it loads inside the worker — part of this build.
import parquetWorkerUrl from '@spatialdata/core/parquet-worker?worker&url';
// The `*InWorker` helpers live on `/workers`; the controls on the root entry.
import { decodeShapesGeometryInWorker } from '@spatialdata/core/workers';
import { useEffect, useState } from 'react';

const shapesParquetUrl = new URL(
  '/test-fixtures/v0.8.0/blobs.zarr/shapes/blobs_polygons/shapes.parquet',
  window.location.href
).href;

/**
 * Proves the published worker entry starts in a real consumer build and can decode:
 * its module format (#148), its `exports` subpath, and the parquet-wasm it resolves
 * inside its own bundle (MDV#539) — a context the main thread never exercises.
 */
export function ParquetWorkerConsumer() {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    enableParquetWorker({ workerUrl: parquetWorkerUrl });
    if (!isParquetWorkerEnabled()) {
      setError('enableParquetWorker did not produce a worker');
      return;
    }
    fetch(shapesParquetUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`Fixture parquet request failed: ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) =>
        decodeShapesGeometryInWorker({
          parts: [new Uint8Array(bytes)],
          geometryColumnName: 'geometry',
          geometryKind: 'polygon',
        })
      )
      .then((geometry) => {
        if (!active) return;
        if (!geometry) throw new Error('Worker decode returned null');
        if (geometry.featureCount <= 0) throw new Error('Worker decode returned no features');
        // A decode that reached the worker means the worker resolved parquet-wasm.
        setStatus(`decoded ${geometry.featureCount} features in the worker`);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) return <div data-testid="worker-error">{error}</div>;
  if (!status) return <div data-testid="worker-pending">decoding…</div>;
  return <div data-testid="worker-ready">{status}</div>;
}
