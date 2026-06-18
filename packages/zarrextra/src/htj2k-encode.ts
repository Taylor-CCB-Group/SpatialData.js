import { createWasmLocateFile, type OpenJphFactory, type RegisterImageCodecOptions } from './codecs';

export type Htj2kPlaneDtype = 'uint8' | 'int8' | 'uint16' | 'int16';

export type Htj2kEncodeOptions = {
  /** Lossless when true. Defaults to true for fixture-style writes. */
  reversible?: boolean;
  /** OpenJPH quantization factor when irreversible (lower = higher fidelity, larger output). */
  quality?: number;
  locateFile?: RegisterImageCodecOptions['locateFile'];
};

type Htj2kFrameInfo = {
  width: number;
  height: number;
  bitsPerSample: 8 | 16;
  isSigned: boolean;
  componentCount: 1;
  isUsingColorTransform: false;
};

type Htj2kEncoderClass = new () => {
  /** OpenJPH WASM API: `setQuality(reversible, quality)`; quality is a quantization factor (lower = better). */
  setQuality(reversible: boolean, quality: number): void;
  getDecodedBuffer(frame: Htj2kFrameInfo): ArrayBufferView;
  encode(): void;
  getEncodedBuffer(): Uint8Array;
};

export type OpenJphEncoder = (
  plane: Uint8Array | Uint16Array | Int8Array | Int16Array,
  size: { width: number; height: number },
  options?: Pick<Htj2kEncodeOptions, 'reversible' | 'quality'>
) => Promise<Uint8Array>;

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<Record<string, unknown>>;

function bitsPerSampleForPlane(
  plane: Uint8Array | Uint16Array | Int8Array | Int16Array
): 8 | 16 {
  return plane instanceof Uint16Array || plane instanceof Int16Array ? 16 : 8;
}

function isSignedPlane(plane: Uint8Array | Uint16Array | Int8Array | Int16Array): boolean {
  return plane instanceof Int8Array || plane instanceof Int16Array;
}

function frameInfoForPlane(
  plane: Uint8Array | Uint16Array | Int8Array | Int16Array,
  size: { width: number; height: number }
): Htj2kFrameInfo {
  const { width, height } = size;
  const expectedValues = width * height;
  if (plane.length !== expectedValues) {
    throw new Error(
      `HTJ2K plane has ${plane.length} samples, expected ${expectedValues} for ${width}x${height}.`
    );
  }
  return {
    width,
    height,
    bitsPerSample: bitsPerSampleForPlane(plane),
    isSigned: isSignedPlane(plane),
    componentCount: 1,
    isUsingColorTransform: false,
  };
}

/** Create an HTJ2K encoder backed by an OpenJPH WASM factory. */
export function createOpenJphEncoder(
  factory: OpenJphFactory,
  options: Pick<Htj2kEncodeOptions, 'locateFile'> = {}
): OpenJphEncoder {
  let runtimePromise: Promise<Record<string, unknown>> | undefined;

  async function getRuntime() {
    runtimePromise ??= Promise.resolve(
      factory({
        locateFile: options.locateFile,
      })
    );
    return await runtimePromise;
  }

  return async (plane, size, encodeOptions = {}) => {
    const runtime = await getRuntime();
    const Encoder = runtime.HTJ2KEncoder as Htj2kEncoderClass | undefined;
    if (!Encoder) {
      throw new Error('OpenJPH runtime does not expose HTJ2KEncoder.');
    }

    const reversible = encodeOptions.reversible ?? true;
    const quality = encodeOptions.quality ?? 0;
    const frame = frameInfoForPlane(plane, size);
    const encoder = new Encoder();
    encoder.setQuality(reversible, quality);

    const buffer = encoder.getDecodedBuffer(frame);
    const target =
      frame.bitsPerSample === 16
        ? new Uint16Array(buffer.buffer, buffer.byteOffset, plane.length)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, plane.length);
    target.set(plane);
    encoder.encode();
    return encoder.getEncodedBuffer();
  };
}

/** Load the optional OpenJPH WASM encoder from @cornerstonejs/codec-openjph. */
export async function loadOpenJphEncoder(
  options: Htj2kEncodeOptions = {}
): Promise<OpenJphEncoder> {
  const factoryMod = await dynamicImport('@cornerstonejs/codec-openjph/wasmjs').catch(() =>
    dynamicImport('@cornerstonejs/codec-openjph')
  );
  const factory = (factoryMod.default ?? factoryMod.OpenJPHJS ?? factoryMod) as unknown;
  if (typeof factory !== 'function') {
    throw new Error('Could not find an OpenJPH factory export in @cornerstonejs/codec-openjph.');
  }
  const wasmMod = await dynamicImport('@cornerstonejs/codec-openjph/wasm').catch(() => null);
  const wasmAsset = wasmMod ? ((wasmMod.default ?? wasmMod) as string | undefined) : undefined;
  const locateFile =
    options.locateFile ?? (wasmAsset ? createWasmLocateFile(wasmAsset) : undefined);
  return createOpenJphEncoder(factory as OpenJphFactory, { locateFile });
}

export function planeArrayForDtype(
  dtype: Htj2kPlaneDtype,
  bytes: Uint8Array
) {
  switch (dtype) {
    case 'uint8':
      return bytes;
    case 'int8':
      return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    case 'uint16':
      return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    case 'int16':
      return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    default:
      throw new Error(`Unsupported HTJ2K plane dtype '${dtype}'.`);
  }
}

/** Encode one 2D plane to an HTJ2K bitstream. */
export async function encodeHtj2kPlane(
  plane: Uint8Array | Uint16Array | Int8Array | Int16Array,
  size: { width: number; height: number },
  options: Htj2kEncodeOptions = {}
): Promise<Uint8Array> {
  const encoder = await loadOpenJphEncoder(options);
  return await encoder(plane, size, options);
}
