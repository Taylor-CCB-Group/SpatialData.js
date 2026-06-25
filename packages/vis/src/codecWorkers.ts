import { enableWorkerChunkDecode } from 'zarrextra/workers';

let enabled = false;

/**
 * Enable the bundled zarrextra codec worker once for browser-based vis components.
 *
 * This is called automatically by SpatialCanvas renderer paths. It is exported for
 * hosts that want to opt in before mounting UI, without risking repeated worker
 * pool replacement.
 */
export function ensureCodecWorkers(): boolean {
  if (enabled || typeof Worker === 'undefined') {
    return enabled;
  }

  enableWorkerChunkDecode();
  enabled = true;
  return enabled;
}
