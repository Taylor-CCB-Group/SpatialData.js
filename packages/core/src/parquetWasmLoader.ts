export interface ParquetWasmTableLike {
  intoIPCStream(): Uint8Array;
}

export interface ParquetWasmFileMetadata {
  numRows(): number;
}

export interface ParquetWasmRowGroupMetadata {
  numRows(): number;
  fileOffset(): number | bigint;
  compressedSize(): number | bigint;
}

export interface ParquetWasmMetadata {
  fileMetadata(): ParquetWasmFileMetadata;
  numRowGroups(): number;
  rowGroup(index: number): ParquetWasmRowGroupMetadata;
}

export interface ParquetRowGroupReadOptions {
  columns?: string[];
  limit?: number;
  offset?: number;
}

export interface ParquetModule {
  readParquet: (bytes: Uint8Array, options?: ParquetRowGroupReadOptions) => ParquetWasmTableLike;
  readSchema: (bytes: Uint8Array) => ParquetWasmTableLike;
  readMetadata?: (bytes: Uint8Array) => ParquetWasmMetadata;
  readParquetRowGroup?: (
    schemaBytes: Uint8Array,
    rowGroupBytes: Uint8Array,
    rowGroupIndex: number,
    options?: ParquetRowGroupReadOptions
  ) => ParquetWasmTableLike;
}

function normalizeParquetModule(module: unknown): ParquetModule {
  if (typeof module !== 'object' || module === null) {
    throw new Error('parquet-wasm module did not load as an object');
  }
  // External WASM builds have drifted API surfaces and incomplete declarations;
  // keep the boundary narrow and capability-check every optional method.
  const candidate = module as Record<string, unknown>;
  const { readParquet, readSchema, readMetadata, readParquetRowGroup } = candidate;
  if (typeof readParquet !== 'function' || typeof readSchema !== 'function') {
    throw new Error('parquet-wasm module is missing required readParquet/readSchema APIs');
  }
  return {
    readParquet: readParquet as ParquetModule['readParquet'],
    readSchema: readSchema as ParquetModule['readSchema'],
    readMetadata:
      typeof readMetadata === 'function'
        ? (readMetadata as ParquetModule['readMetadata'])
        : undefined,
    readParquetRowGroup:
      typeof readParquetRowGroup === 'function'
        ? (readParquetRowGroup as ParquetModule['readParquetRowGroup'])
        : undefined,
  };
}

async function initializeParquetModule(module: unknown) {
  if (typeof module !== 'object' || module === null) {
    return;
  }
  const maybeInit = (module as Record<string, unknown>).default;
  if (typeof maybeInit === 'function') {
    await maybeInit();
  }
}

function parquetModuleSupportsRowGroupReads(module: ParquetModule): boolean {
  return (
    typeof module.readMetadata === 'function' && typeof module.readParquetRowGroup === 'function'
  );
}

async function loadParquetModuleFromCdn(): Promise<ParquetModule> {
  const cdnModule = await import(
    // @ts-expect-error - CDN import not recognized by TypeScript
    'https://cdn.vitessce.io/parquet-wasm@2c23652/esm/parquet_wasm.js'
  );
  await initializeParquetModule(cdnModule);
  return normalizeParquetModule(cdnModule);
}

let parquetModulePromise: Promise<ParquetModule> | undefined;

export function getParquetModule(): Promise<ParquetModule> {
  if (!parquetModulePromise) {
    parquetModulePromise = loadParquetModule();
  }
  return parquetModulePromise;
}

async function loadParquetModule(): Promise<ParquetModule> {
  // Dynamic import for code-splitting. parquet-wasm is a WebAssembly module
  // that needs to be initialized before use in browser environments.
  // In Node.js, the module loads WASM synchronously so no init is needed.
  //
  // TODO: Replace with a more civilised parquet module that's built in a way we can actually consume.
  // - probably ultimately may be using geoarrow-wasm / investigate deck.gl arrow layer
  //   think about how that fits our 'core' (no deck deps) vs 'vis' structure etc.

  const useCdnForMissingRowGroupApis = typeof window !== 'undefined';

  // Try local import first (works in Node.js, tests, and production builds)
  try {
    const module = await import('parquet-wasm');
    await initializeParquetModule(module);
    const normalized = normalizeParquetModule(module);
    if (!parquetModuleSupportsRowGroupReads(normalized) && useCdnForMissingRowGroupApis) {
      console.warn(
        '[parquetWasmLoader] Local parquet-wasm lacks row-group APIs; falling back to CDN build.'
      );
      return loadParquetModuleFromCdn();
    }
    return normalized;
  } catch (error) {
    // Local import failed, try CDN fallback (needed in vite dev server)
    // Reference: https://observablehq.com/@kylebarron/geoparquet-on-the-web
    console.warn(
      '[parquetWasmLoader] Local parquet-wasm import failed, falling back to CDN version. ' +
        'This is a temporary workaround pending a better parquet module solution.',
      error
    );

    try {
      return loadParquetModuleFromCdn();
    } catch (cdnError) {
      const localErrorMsg = error instanceof Error ? error.message : String(error);
      const cdnErrorMsg = cdnError instanceof Error ? cdnError.message : String(cdnError);
      throw new Error(
        `Failed to load parquet-wasm from both local package and CDN. Local error: ${localErrorMsg}. CDN error: ${cdnErrorMsg}`
      );
    }
  }
}
