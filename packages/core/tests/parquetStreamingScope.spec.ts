import { afterEach, describe, expect, it, vi } from 'vitest';
import { supportsParquetStreaming } from '../src/parquetWasmLoader.js';

/**
 * `ParquetFile.stream` needs only `fetch` and WASM, both of which a Worker has —
 * but this check used `window` as a stand-in for "is a browser", which excluded
 * workers by accident and so forced the streaming feature scan to decode on the
 * main thread.
 *
 * The Node exclusion is not stylistic: the reader's async fetch path panics there
 * with `RuntimeError: unreachable`, and the panic escapes try/catch, so it cannot
 * be probed defensively and must stay gated up front.
 */
const g = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('supportsParquetStreaming', () => {
  it('is false under Node, where the reader panics unrecoverably', () => {
    // The real test environment: `process.versions.node` is set.
    expect(supportsParquetStreaming()).toBe(false);
  });

  it('accepts a worker scope — no window, but WorkerGlobalScope present', () => {
    vi.stubGlobal('process', undefined);
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('WorkerGlobalScope', class {});
    vi.stubGlobal('fetch', () => Promise.resolve());
    expect(supportsParquetStreaming()).toBe(true);
  });

  it('accepts the browser main thread', () => {
    vi.stubGlobal('process', undefined);
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', () => Promise.resolve());
    expect(supportsParquetStreaming()).toBe(true);
  });

  it('rejects a scope that is neither — no window, no WorkerGlobalScope', () => {
    vi.stubGlobal('process', undefined);
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('fetch', () => Promise.resolve());
    const had = 'WorkerGlobalScope' in g;
    if (had) {
      vi.stubGlobal('WorkerGlobalScope', undefined);
    }
    expect(supportsParquetStreaming()).toBe(false);
  });

  it('rejects any scope without fetch', () => {
    vi.stubGlobal('process', undefined);
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', undefined);
    expect(supportsParquetStreaming()).toBe(false);
  });

  it('still rejects Node even when a fetch polyfill is present', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', () => Promise.resolve());
    // `process.versions.node` is set by the real environment here.
    expect(supportsParquetStreaming()).toBe(false);
  });
});
