import OpenJPHJS from '@cornerstonejs/codec-openjph';
import openJphWasmUrl from '@cornerstonejs/codec-openjph/wasm?url';
import OpenJPEGJS from '@cornerstonejs/codec-openjpeg/decode';
import openJpegWasmUrl from '@cornerstonejs/codec-openjpeg/decodewasm?url';
import {
  createOpenJpegDecoder,
  createOpenJphDecoder,
  createWasmLocateFile,
  registerExperimentalHtj2kCodec,
  registerJpeg2kCodec,
  wrapZarrRegistryForFizarritaWorker,
} from '../codecs';

wrapZarrRegistryForFizarritaWorker();
registerJpeg2kCodec({
  decoder: createOpenJpegDecoder(OpenJPEGJS, {
    locateFile: createWasmLocateFile(openJpegWasmUrl),
  }),
});
registerExperimentalHtj2kCodec({
  decoder: createOpenJphDecoder(OpenJPHJS, {
    locateFile: createWasmLocateFile(openJphWasmUrl),
  }),
});

import '@fideus-labs/fizarrita/codec-worker';
