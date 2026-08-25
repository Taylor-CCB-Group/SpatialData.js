import { enableParquetWorker, isParquetWorkerEnabled } from '@spatialdata/core';
// The documented consumer recipe, exercised against the built artifact. A bundled
// application cannot use the no-argument form: the bundler inlines core's chunk into
// its own output, so the runtime-relative `./parquet-worker.js` no longer resolves.
// This import is what makes the worker's own bundle — including the parquet-wasm it
// loads inside the worker, a second bundling context the main thread never
// exercises — part of the application's build.
import parquetWorkerUrl from '@spatialdata/core/parquet-worker?worker&url';
// The `*InWorker` helpers live on the `/workers` entry; the enable/disable controls
// are on the root one.
import { decodeShapesGeometryInWorker } from '@spatialdata/core/workers';
import { useEffect, useState } from 'react';

const shapesParquetUrl = new URL(
  '/test-fixtures/v0.8.0/blobs.zarr/shapes/blobs_polygons/shapes.parquet',
  window.location.href
).href;

/**
 * Proves the published worker entry starts in a real consumer build and can decode.
 *
 * This is the scenario that would have caught SpatialData.js#148 (the worker entry
 * shipped as CommonJS, so `new Worker(url, { type: 'module' })` died on `require is
 * not defined`) and the parquet-wasm 404 that MDV#539 had to work around — the
 * worker resolves that wasm from inside its own bundle, a second bundling context
 * the main thread never exercises.
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
