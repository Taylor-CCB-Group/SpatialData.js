import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  disableParquetWorker,
  enableParquetWorker,
  isParquetWorkerEnabled,
} from '../src/workers/parquetWorkerClient.js';

/**
 * Constructing a Worker can throw synchronously, and everything else in this client
 * treats a bad worker as a performance cost rather than a failure — a dead worker is
 * detected, switched off, and callers take their main-thread fallbacks.
 *
 * A throwing constructor used to break that promise by propagating out of
 * `enableParquetWorker`, and therefore out of `ensureWorkers`, taking the caller's
 * render with it. Two ways it happens in practice: a host `createWorker` factory that
 * throws, and `new Worker` itself rejecting a URL or being refused by CSP.
 */
const g = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  disableParquetWorker();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('enableParquetWorker construction failures', () => {
  it('does not throw when a createWorker factory throws', () => {
    vi.stubGlobal(
      'Worker',
      class {
        terminate() {}
      }
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() =>
      enableParquetWorker({
        createWorker: () => {
          throw new Error('bundler produced no worker');
        },
      })
    ).not.toThrow();

    expect(isParquetWorkerEnabled()).toBe(false);
    expect(warn).toHaveBeenCalled();
    // The reason has to survive into the message, or this is undebuggable.
    expect(String(warn.mock.calls[0]?.[0])).toContain('bundler produced no worker');
  });

  it('does not throw when the Worker constructor itself throws', () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('refused by CSP');
        }
      }
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => enableParquetWorker({ workerUrl: 'https://example.invalid/w.js' })).not.toThrow();

    expect(isParquetWorkerEnabled()).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('leaves the worker off rather than half-enabled', () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('nope');
        }
      }
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    enableParquetWorker({ createWorker: () => new (g.Worker as new () => Worker)() });

    // `isParquetWorkerEnabled` is `enabled && worker !== undefined`; a construction
    // failure must clear both, so callers with no fallback fail fast and loudly
    // instead of posting into a worker that is not there.
    expect(isParquetWorkerEnabled()).toBe(false);
  });
});
