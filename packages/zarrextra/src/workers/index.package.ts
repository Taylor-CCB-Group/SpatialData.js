import {
  createWorkerChunkDecodeControls,
  type EnableWorkerChunkDecodeOptions,
} from './workerControls';
import { defaultWorkerUrl } from './workerUrl.package';

export type { ChunkCache, GetWorkerOptions } from '@fideus-labs/fizarrita';
export type { EnableWorkerChunkDecodeOptions };

const controls = createWorkerChunkDecodeControls(defaultWorkerUrl);

export const enableWorkerChunkDecode = controls.enableWorkerChunkDecode;
export const disableWorkerChunkDecode = controls.disableWorkerChunkDecode;
