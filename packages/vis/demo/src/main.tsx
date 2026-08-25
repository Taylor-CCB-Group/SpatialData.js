import { ensureWorkers } from '@spatialdata/vis';
import React from 'react';
import ReactDOM from 'react-dom/client';
// The worker's TS source, because the demo lives in the repo — a consumer imports
// '@spatialdata/core/parquet-worker?worker&url' instead. Either way it is the import
// that puts the worker in this build; see docs/docs/bundling.mdx.
import parquetWorkerUrl from '../../../core/src/workers/parquet-worker.ts?worker&url';
import App from './App';
import './index.css';

// Moves the CPU-heavy work off the main thread: the codes-with-geometry preload
// decode, and the per-interaction batch filter (which transfers the resident batch
// rather than re-fetching). A large transcripts decode legitimately runs tens of
// seconds in the worker, hence the widened timeout; on timeout the caller falls back
// to the main thread rather than failing.
ensureWorkers({ parquet: { workerUrl: parquetWorkerUrl, requestTimeoutMs: 120_000 } });

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element not found');
}
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
