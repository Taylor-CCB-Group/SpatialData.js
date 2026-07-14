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
  const record = module as Record<string, unknown>;
  const initSync = record.initSync;
  const defaultInit = record.default;

  // Vitest/Node load the vendored browser ESM glue; initialize WASM from disk
  // because undici cannot fetch file:// URLs.
  //
  // Detect Node from the runtime itself, NOT from `import.meta.url`. Bundlers
  // rewrite `import.meta.url` to a file:// URL inside a *browser* bundle
  // (webpack does this for the docs site), so a `startsWith('file:')` check is
  // true in the browser too. That sent us into this branch with node:fs/node:url/
  // node:path replaced by empty browser stubs, so `fileURLToPath` was undefined:
  //   TypeError: t is not a function
  const isNodeRuntime =
    typeof process !== 'undefined' &&
    process.versions?.node != null &&
    typeof window === 'undefined';

  if (isNodeRuntime && typeof initSync === 'function') {
    const [{ readFileSync }, { fileURLToPath }, { dirname, join }] = await Promise.all([
      import('node:fs'),
      import('node:url'),
      import('node:path'),
    ]);
    const wasmPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../vendor/parquet-wasm/parquet_wasm_bg.wasm'
    );
    initSync({ module: readFileSync(wasmPath) });
    return;
  }

  if (typeof defaultInit === 'function') {
    await defaultInit();
  }
}

function parquetModuleSupportsRowGroupReads(module: ParquetModule): boolean {
  return (
    typeof module.readMetadata === 'function' && typeof module.readParquetRowGroup === 'function'
  );
}

async function loadVendoredParquetModule(): Promise<ParquetModule> {
  const module: unknown = await import(
    /* @vite-ignore */
    '../vendor/parquet-wasm/parquet_wasm.js'
  );
  await initializeParquetModule(module);
  const normalized = normalizeParquetModule(module);
  if (!parquetModuleSupportsRowGroupReads(normalized)) {
    throw new Error(
      'Vendored parquet-wasm is missing required row-group APIs (readMetadata, readParquetRowGroup)'
    );
  }
  return normalized;
}

let parquetModulePromise: Promise<ParquetModule> | undefined;

export function getParquetModule(): Promise<ParquetModule> {
  if (!parquetModulePromise) {
    parquetModulePromise = loadVendoredParquetModule();
  }
  return parquetModulePromise;
}
