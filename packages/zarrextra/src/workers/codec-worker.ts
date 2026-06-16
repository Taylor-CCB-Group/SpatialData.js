import OpenJPEGJS from '@cornerstonejs/codec-openjpeg/decode';
import {
  createOpenJpegDecoder,
  registerJpeg2kCodec,
  wrapZarrRegistryForFizarritaWorker,
} from '../codecs';

wrapZarrRegistryForFizarritaWorker();
registerJpeg2kCodec({ decoder: createOpenJpegDecoder(OpenJPEGJS) });

import '@fideus-labs/fizarrita/codec-worker';
