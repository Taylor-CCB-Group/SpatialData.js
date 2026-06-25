import { Sketch } from '@spatialdata/vis';
import { enableWorkerChunkDecode } from 'zarrextra/workers';

let enabled = false;

function ensureDocsWorkerChunkDecode() {
  if (enabled || typeof Worker === 'undefined') {
    return;
  }

  enableWorkerChunkDecode();
  enabled = true;
}

ensureDocsWorkerChunkDecode();

export default function DocsSketch() {
  ensureDocsWorkerChunkDecode();
  return <Sketch />;
}
