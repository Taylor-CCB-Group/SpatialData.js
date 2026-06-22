import { enablePointsWorker } from '@spatialdata/core';

let enabled = false;

/** Enable points worker decode/filter once for all vis demo routes. */
export function ensureDemoPointsWorker() {
  if (enabled || typeof Worker === 'undefined') {
    return;
  }

  enablePointsWorker();
  enabled = true;
}
