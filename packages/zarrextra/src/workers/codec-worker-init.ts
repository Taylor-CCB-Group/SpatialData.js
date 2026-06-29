import { decode as openJphDecode } from 'openjph-wasm';
import openJphWasmUrl from 'openjph-wasm/wasm/libopenjph.wasm?url';
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
  decoder: createOpenJphDecoder(openJphDecode, {
    locateFile: createWasmLocateFile(openJphWasmUrl),
  }),
});
