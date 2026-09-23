import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  disableParquetWorker,
  enableParquetWorker,
  isParquetWorkerEnabled,
} from '../src/workers/parquetWorkerClient.js';

/**
 * parquet-wasm answers a refused HTTP range by panicking with `RuntimeError:
 * unreachable` and leaving its promise unsettled. That panic surfaces as the worker's
 * `error` event, and it can arrive before the worker has replied to anything — so
 * "has it answered a request yet?" misreads a well-wired worker that crashed as one
 * that never loaded, and switches the feature off for the rest of the page.
 *
 * The `ready` message the worker posts on load is what tells the two apart. A crash
 * after `ready` is recoverable and the worker is replaced; an `error` with no `ready`
 * is a wiring mistake and still gives up.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  terminated = false;
  posted: unknown[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  /** What the real worker posts once its module has evaluated. */
  signalReady() {
    this.onmessage?.({ data: { id: -1, direction: 'ready' } });
  }
  crash(message = 'Uncaught RuntimeError: unreachable') {
    this.onerror?.({ message });
  }
  /** A reply to a request nobody is waiting for: enough to mark the worker healthy. */
  answer() {
    this.onmessage?.({
      data: { id: 999, direction: 'response', response: { ok: false, error: 'no such id' } },
    });
  }
}

function startWorker() {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  enableParquetWorker({ createWorker: () => new FakeWorker() as unknown as Worker });
  return FakeWorker.instances;
}

afterEach(() => {
  disableParquetWorker();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWorker.instances = [];
});

describe('parquet worker crash recovery', () => {
  it('replaces a worker that crashed after loading, instead of switching it off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const instances = startWorker();
    instances[0]?.signalReady();

    instances[0]?.crash();

    expect(isParquetWorkerEnabled()).toBe(true);
    expect(instances).toHaveLength(2);
    expect(instances[0]?.terminated).toBe(true);
    expect(String(warn.mock.calls[0]?.[0])).toContain('restarting');
  });

  it('still gives up on a worker that never loaded', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const instances = startWorker();

    // No `ready`: the bundle never evaluated, so this is a wiring mistake.
    instances[0]?.crash('Failed to load worker script');

    expect(isParquetWorkerEnabled()).toBe(false);
    expect(instances).toHaveLength(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('failed to start');
  });

  it('gives up once a worker crashes repeatedly without answering', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const instances = startWorker();

    // Each replacement loads and immediately dies: a deterministically broken store
    // must not spawn workers forever.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const live = instances.at(-1);
      live?.signalReady();
      live?.crash();
    }

    expect(isParquetWorkerEnabled()).toBe(false);
    expect(instances.length).toBeLessThanOrEqual(4);
  });

  it('replenishes the restart budget when a worker answers', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const instances = startWorker();

    for (let round = 0; round < 5; round += 1) {
      const live = instances.at(-1);
      live?.signalReady();
      // A reply proves this worker is healthy, whatever the previous one did.
      live?.answer();
      live?.crash();
      expect(isParquetWorkerEnabled()).toBe(true);
      // Replaced each round, not merely left enabled: five crashes past a budget of
      // three only survive because answering refills it.
      expect(instances).toHaveLength(round + 2);
    }
  });

  /**
   * The common case, and the one the first cut of this got wrong. Metadata and catalog
   * requests usually succeed before a refused range panics, and gating recovery on
   * "has not answered yet" left the dead worker installed with
   * `isParquetWorkerEnabled()` still true — so every later request waited out the
   * silence watchdog instead of reaching a live worker.
   */
  it('replaces a worker that crashes after it has already answered', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const instances = startWorker();
    instances[0]?.signalReady();
    instances[0]?.answer();

    instances[0]?.crash();

    expect(instances).toHaveLength(2);
    expect(instances[0]?.terminated).toBe(true);
    expect(isParquetWorkerEnabled()).toBe(true);
  });
});
