import { enableWorkerChunkDecode } from 'zarrextra/workers';

let enabled = false;

/** Enable fizarrita worker decode once for all vis demo routes (Sketch, codec fixture, …). */
export function ensureDemoWorkerChunkDecode() {
  if (enabled || typeof Worker === 'undefined') {
    return;
  }

  enableWorkerChunkDecode();
  enabled = true;
}
