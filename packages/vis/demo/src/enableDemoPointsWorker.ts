import { enablePointsWorker } from '@spatialdata/core';

let enabled = false;

/** Enable points worker decode/filter once for all vis demo routes. */
export function ensureDemoPointsWorker() {
  if (enabled || typeof Worker === 'undefined') {
    return;
  }

  enablePointsWorker({
    workerUrl: new URL('../../../core/src/workers/points-worker.ts', import.meta.url),
  });
  enabled = true;
}
