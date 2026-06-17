import * as zarr from 'zarrita';

type ChunkMetadata<D extends zarr.DataType = zarr.DataType> = {
  dataType: D;
  shape: number[];
  codecs: zarr.CodecMetadata[];
  fillValue: zarr.Scalar<D> | null;
};

/** Chunk metadata from zarrita (camelCase) or fizarrita workers (snake_case). */
type ChunkMetadataInput = Partial<ChunkMetadata> & {
  data_type?: zarr.DataType;
  chunk_shape?: number[];
  fill_value?: zarr.Scalar<zarr.DataType> | null;
};

function normalizeChunkMetadata(meta: ChunkMetadataInput): ChunkMetadata {
  const dataType = meta.dataType ?? meta.data_type;
  const shape = meta.shape ?? meta.chunk_shape;
  if (!dataType) {
    throw new Error('Chunk metadata is missing dataType / data_type.');
  }
  if (!shape) {
    throw new Error('Chunk metadata is missing shape / chunk_shape.');
  }
  return {
    dataType,
    shape,
    codecs: meta.codecs ?? [],
    fillValue: meta.fillValue ?? meta.fill_value ?? null,
  };
}

type Codec = {
  kind?: 'array_to_array' | 'array_to_bytes' | 'bytes_to_bytes';
  encode(data: unknown): Promise<Uint8Array> | Uint8Array;
  decode(data: Uint8Array): Promise<zarr.Chunk<zarr.DataType>> | zarr.Chunk<zarr.DataType>;
};

type CodecEntry = {
  kind?: Codec['kind'];
  fromConfig: (config: unknown, meta: ChunkMetadata) => Codec;
};

export type DecodedImageBytes = ArrayBuffer | ArrayBufferView;

export type ImageCodecDecoder = (
  encoded: Uint8Array,
  meta: ChunkMetadata,
  config: unknown
) => Promise<DecodedImageBytes> | DecodedImageBytes;

export interface RegisterImageCodecOptions {
  /**
   * Override the codec ids registered into Zarrita's global registry.
   * Defaults include the standard registry id and a pragmatic alias.
   */
  ids?: string[];
  /** Custom decoder used by tests or applications with their own WASM loading. */
  decoder?: ImageCodecDecoder;
  /** Optional Emscripten locateFile hook for bundled WASM decoders. */
  locateFile?: (path: string, prefix: string) => string;
}

export type OpenJpegFactory = (opts?: {
  locateFile?: RegisterImageCodecOptions['locateFile'];
}) => Promise<Record<string, unknown>> | Record<string, unknown>;

export type OpenJphFactory = (opts?: {
  locateFile?: RegisterImageCodecOptions['locateFile'];
}) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** Emscripten locateFile hook that resolves bundled codec WASM to a bundler URL. */
export function createWasmLocateFile(
  wasmUrl: string
): NonNullable<RegisterImageCodecOptions['locateFile']> {
  return (path, _prefix) => (path.endsWith('.wasm') ? wasmUrl : path);
}

const JPEG2K_CODEC_IDS = ['imagecodecs_jpeg2k', 'numcodecs.imagecodecs_jpeg2k', 'jpeg2k'];
const HTJ2K_OPENJPH_CODEC_ID = 'experimental.openjph_htj2k';
const HTJ2K_LEGACY_CODEC_IDS = [
  'experimental.imagecodecs_htj2k',
  'imagecodecs_htj2k',
  'numcodecs.imagecodecs_htj2k',
];
const HTJ2K_CODEC_IDS = [HTJ2K_OPENJPH_CODEC_ID, ...HTJ2K_LEGACY_CODEC_IDS];

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<Record<string, unknown>>;

function unsupportedEncode(codecName: string): never {
  throw new Error(`${codecName} encode is not implemented in zarrextra; decode-only for now.`);
}

function toUint8Array(data: DecodedImageBytes): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

function copyArrayBufferView(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function product(values: number[]): number {
  return values.reduce((acc, value) => acc * value, 1);
}

function getStrides(shape: number[]): number[] {
  const stride = new Array<number>(shape.length);
  let step = 1;
  for (let index = shape.length - 1; index >= 0; index -= 1) {
    stride[index] = step;
    step *= shape[index] ?? 1;
  }
  return stride;
}

function typedArrayFromDecodedBytes(
  decoded: DecodedImageBytes,
  meta: ChunkMetadata
): zarr.TypedArray<zarr.DataType> {
  if (Array.isArray(decoded)) {
    throw new Error('Image codec decoder returned a plain array; expected binary data.');
  }

  const decodedBytes = toUint8Array(decoded);
  const buffer = copyArrayBufferView(decodedBytes);
  const expectedValues = product(meta.shape);

  let data: zarr.TypedArray<zarr.DataType>;
  switch (meta.dataType) {
    case 'uint8':
      data = new Uint8Array(buffer);
      break;
    case 'int8':
      data = new Int8Array(buffer);
      break;
    case 'uint16':
      data = new Uint16Array(buffer);
      break;
    case 'int16':
      data = new Int16Array(buffer);
      break;
    case 'uint32':
      data = new Uint32Array(buffer);
      break;
    case 'int32':
      data = new Int32Array(buffer);
      break;
    case 'float32':
      data = new Float32Array(buffer);
      break;
    case 'float64':
      data = new Float64Array(buffer);
      break;
    default:
      throw new Error(`Image codec does not support Zarrita dtype '${meta.dataType}'.`);
  }

  if (data.length !== expectedValues) {
    throw new Error(
      `Image codec decoded ${data.length} values, expected ${expectedValues} for chunk shape ` +
        `[${meta.shape.join(', ')}].`
    );
  }

  return data;
}

function createImageCodecEntry(
  codecName: string,
  decoder: ImageCodecDecoder
): () => Promise<CodecEntry> {
  return async () => ({
    kind: 'array_to_bytes',
    fromConfig(config: unknown, meta: ChunkMetadataInput): Codec {
      const chunkMeta = normalizeChunkMetadata(meta);
      return {
        kind: 'array_to_bytes',
        encode: () => unsupportedEncode(codecName),
        async decode(encoded: Uint8Array) {
          const decoded = await decoder(encoded, chunkMeta, config);
          return {
            data: typedArrayFromDecodedBytes(decoded, chunkMeta),
            shape: chunkMeta.shape,
            stride: getStrides(chunkMeta.shape),
          };
        },
      };
    },
  });
}

/**
 * Adapt zarrita's built-in registry codecs for fizarrita's worker metadata
 * (`data_type`, `chunk_shape`) before fizarrita's codec worker loads.
 */
export function wrapZarrRegistryForFizarritaWorker() {
  const { registry } = zarr;
  for (const [id, factory] of [...registry.entries()]) {
    registry.set(id, async () => {
      const entry = await factory();
      if (typeof entry.fromConfig !== 'function') {
        return entry;
      }
      const fromConfig = entry.fromConfig.bind(entry);
      return {
        ...entry,
        fromConfig(config: unknown, meta: ChunkMetadataInput) {
          return fromConfig(config, normalizeChunkMetadata(meta));
        },
      };
    });
  }
}

export function createOpenJpegDecoder(
  factory: OpenJpegFactory,
  options: Pick<RegisterImageCodecOptions, 'locateFile'> = {}
): ImageCodecDecoder {
  let runtimePromise: Promise<Record<string, unknown>> | undefined;
  async function getRuntime() {
    runtimePromise ??= Promise.resolve(
      factory({
        locateFile: options.locateFile,
      })
    );
    return await runtimePromise;
  }
  return async (encoded) => {
    const runtime = await getRuntime();
    const Decoder = runtime.J2KDecoder as
      | (new () => {
          getEncodedBuffer(length: number): Uint8Array;
          decode(): void;
          getDecodedBuffer(): DecodedImageBytes;
        })
      | undefined;
    if (!Decoder) {
      throw new Error('OpenJPEG runtime does not expose J2KDecoder.');
    }
    const decoder = new Decoder();
    decoder.getEncodedBuffer(encoded.length).set(encoded);
    decoder.decode();
    return decoder.getDecodedBuffer();
  };
}

async function loadOpenJpegDecoder(options: RegisterImageCodecOptions): Promise<ImageCodecDecoder> {
  const mod = await dynamicImport('@cornerstonejs/codec-openjpeg/decode').catch(() =>
    dynamicImport('@cornerstonejs/codec-openjpeg')
  );
  const factory = (mod.default ?? mod.OpenJPEGJS ?? mod.OpenJPEGWASM ?? mod) as unknown;
  if (typeof factory !== 'function') {
    throw new Error('Could not find an OpenJPEG factory export in @cornerstonejs/codec-openjpeg.');
  }
  return createOpenJpegDecoder(factory as OpenJpegFactory, options);
}

type Htj2kDecoderClass = new () => {
  getEncodedBuffer(length: number): Uint8Array;
  decode(): void;
  getDecodedBuffer(): DecodedImageBytes;
};

export function createOpenJphDecoder(
  factory: OpenJphFactory,
  options: Pick<RegisterImageCodecOptions, 'locateFile'> = {}
): ImageCodecDecoder {
  let runtimePromise: Promise<Record<string, unknown>> | undefined;
  async function getRuntime() {
    runtimePromise ??= Promise.resolve(
      factory({
        locateFile: options.locateFile,
      })
    );
    return await runtimePromise;
  }
  return async (encoded) => {
    const runtime = await getRuntime();
    const Decoder = (runtime.HTJ2KDecoder ?? runtime.JPHDecoder ?? runtime.J2KDecoder) as
      | Htj2kDecoderClass
      | undefined;
    if (!Decoder) {
      throw new Error(
        'OpenJPH runtime does not expose a known decoder class; pass a custom decoder option.'
      );
    }
    const decoder = new Decoder();
    decoder.getEncodedBuffer(encoded.length).set(encoded);
    decoder.decode();
    return decoder.getDecodedBuffer();
  };
}

async function loadOpenJphDecoder(options: RegisterImageCodecOptions): Promise<ImageCodecDecoder> {
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
  return createOpenJphDecoder(factory as OpenJphFactory, { locateFile });
}

function registerImageCodec(
  codecName: string,
  defaultIds: string[],
  defaultDecoder: (options: RegisterImageCodecOptions) => Promise<ImageCodecDecoder>,
  options: RegisterImageCodecOptions = {}
) {
  const ids = options.ids ?? defaultIds;
  let decoderPromise: Promise<ImageCodecDecoder> | undefined;
  const getDecoder = async () => {
    decoderPromise ??= Promise.resolve(options.decoder ?? defaultDecoder(options));
    return await decoderPromise;
  };

  for (const id of ids) {
    (zarr.registry as Map<string, () => Promise<unknown>>).set(
      id,
      createImageCodecEntry(codecName, async (encoded, meta, config) => {
        const decoder = await getDecoder();
        return await decoder(encoded, meta, config);
      })
    );
  }
}

/** Register decode support for the standard `imagecodecs_jpeg2k` Zarr codec id. */
export function registerJpeg2kCodec(options: RegisterImageCodecOptions = {}) {
  registerImageCodec('imagecodecs_jpeg2k', JPEG2K_CODEC_IDS, loadOpenJpegDecoder, options);
}

/**
 * Register HTJ2K decode support for OpenJPH-encoded stores and legacy ids.
 *
 * New writes use `experimental.openjph_htj2k`. Older fixtures may use
 * `experimental.imagecodecs_htj2k`; both decode through the same OpenJPH WASM path.
 */
export function registerExperimentalHtj2kCodec(options: RegisterImageCodecOptions = {}) {
  registerImageCodec(
    HTJ2K_OPENJPH_CODEC_ID,
    HTJ2K_CODEC_IDS,
    loadOpenJphDecoder,
    options
  );
}
