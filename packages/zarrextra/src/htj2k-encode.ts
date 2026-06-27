import { type OpenJphInitOptions, type RegisterImageCodecOptions } from './codecs';

export type Htj2kPlaneDtype = 'uint8' | 'int8' | 'uint16' | 'int16';

export type Htj2kEncodeOptions = {
  /** Lossless when true. Defaults to true for fixture-style writes. */
  reversible?: boolean;
  /** OpenJPH quantization factor when irreversible (lower = higher fidelity, larger output). */
  quality?: number;
  locateFile?: RegisterImageCodecOptions['locateFile'];
};

type Htj2kPlane = Uint8Array | Uint16Array | Int8Array | Int16Array;

/** Encode input accepted by the `openjph-wasm` `encode` function. */
export type OpenJphEncodeInput = {
  /** Planar, component-major samples; `length === components*width*height`. */
  data: Htj2kPlane | Int32Array;
  width: number;
  height: number;
  components?: number;
  bitDepth?: number;
  isSigned?: boolean;
  reversible?: boolean;
  quality?: number;
  decompositions?: number;
  blockSize?: [number, number];
};

/** The `encode` function exported by `openjph-wasm`. */
export type OpenJphEncode = (
  input: OpenJphEncodeInput,
  options?: OpenJphInitOptions
) => Promise<Uint8Array>;

export type OpenJphEncoder = (
  plane: Htj2kPlane,
  size: { width: number; height: number },
  options?: Pick<Htj2kEncodeOptions, 'reversible' | 'quality'>
) => Promise<Uint8Array>;

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<Record<string, unknown>>;

/** Create an HTJ2K encoder backed by the `openjph-wasm` `encode` function. */
export function createOpenJphEncoder(
  encode: OpenJphEncode,
  options: Pick<Htj2kEncodeOptions, 'locateFile'> = {}
): OpenJphEncoder {
  const initOptions = options.locateFile ? { locateFile: options.locateFile } : undefined;
  return async (plane, size, encodeOptions = {}) => {
    const expectedValues = size.width * size.height;
    if (plane.length !== expectedValues) {
      throw new Error(
        `HTJ2K plane has ${plane.length} samples, expected ${expectedValues} for ${size.width}x${size.height}.`
      );
    }
    const reversible = encodeOptions.reversible ?? true;
    // bitDepth / isSigned are inferred from the typed array by openjph-wasm.
    const input: OpenJphEncodeInput = {
      data: plane,
      width: size.width,
      height: size.height,
      components: 1,
      reversible,
    };
    if (!reversible) {
      input.quality = encodeOptions.quality ?? 0;
    }
    return await encode(input, initOptions);
  };
}

/** Load the optional OpenJPH WASM encoder from openjph-wasm. */
export async function loadOpenJphEncoder(
  options: Htj2kEncodeOptions = {}
): Promise<OpenJphEncoder> {
  const mod = await dynamicImport('openjph-wasm');
  const encode = (mod.encode ??
    (mod.default as Record<string, unknown> | undefined)?.encode) as OpenJphEncode | undefined;
  if (typeof encode !== 'function') {
    throw new Error('Could not find an encode() export in openjph-wasm.');
  }
  return createOpenJphEncoder(encode, options);
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
