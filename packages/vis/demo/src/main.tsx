import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// NOTE: the points worker is intentionally NOT enabled here yet. The core worker
// is fully wired and safe to enable (see enablePointsWorker + the request-timeout
// fallback in pointsWorkerClient), but for the feature-catalog build on a
// transcripts element WITHOUT an explicit `{feature_key}_codes` column, the
// worker path reads the *full* parquet parts (readParquetWorkerPayload with
// fullPartsForFallback) before scanning, which is far slower than the
// main-thread path's *projected* single-column range read. Enabling it here
// regressed a real Xenium dataset from ~20s to >150s. Efficient worker-offload
// needs a projected/dictionary-only worker payload path — tracked as a follow-up
// in docs/plans/points-mvp-and-roadmap.md.

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element not found');
}
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
