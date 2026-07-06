declare const init: (moduleOrPath?: unknown) => Promise<unknown>;
export function initSync(module?: unknown): unknown;
export function readParquet(
  bytes: Uint8Array,
  options?: { columns?: string[]; limit?: number; offset?: number }
): { intoIPCStream(): Uint8Array };
export function readSchema(bytes: Uint8Array): { intoIPCStream(): Uint8Array };
export function readMetadata(bytes: Uint8Array): unknown;
export function readParquetRowGroup(
  footerBytes: Uint8Array,
  rowGroupBytes: Uint8Array,
  rowGroupIndex: number,
  options?: { columns?: string[]; limit?: number; offset?: number }
): { intoIPCStream(): Uint8Array };
export default init;
