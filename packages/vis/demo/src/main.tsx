import { enableParquetWorker, setParquetWorkerRequestTimeout } from '@spatialdata/core';
import React from 'react';
import ReactDOM from 'react-dom/client';
// Vite bundles the core parquet worker and hands us a runtime URL. Enabling it
// moves the CPU-heavy work off the main thread so the UI stays responsive:
//  - the codes-with-geometry preload decode (decodeGeometryWithFeatures) — the
//    main thread only does async range-read fetches, the worker decodes;
//  - the per-interaction batch filter (filterColumnarByFeatureCodes, transfers
//    the resident batch — no file re-fetch).
// A silent/misconfigured worker still falls back to the main thread via the
// parquetWorkerClient request timeout. Large transcripts decodes can legitimately
// run tens of seconds in the worker, so widen the timeout accordingly.
import parquetWorkerUrl from '../../../core/src/workers/parquet-worker.ts?worker&url';
import App from './App';
import './index.css';

enableParquetWorker({ workerUrl: parquetWorkerUrl });
setParquetWorkerRequestTimeout(120_000);

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element not found');
}
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
