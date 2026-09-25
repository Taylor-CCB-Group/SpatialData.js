import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countFeatureCodesInWorker,
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
  /**
   * Answer the request currently in flight, successfully. It has to be BOTH — a
   * pending id and `ok: true` — because that is now the only thing that counts as
   * recovery; an error, or a reply on an id nobody awaits, deliberately does not.
   */
  answer(id: number) {
    this.onmessage?.({
      data: {
        id,
        direction: 'response',
        response: { ok: true, result: { kind: 'streamCancelled' } },
      },
    });
  }
}

function startWorker() {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  enableParquetWorker({ createWorker: () => new FakeWorker() as unknown as Worker });
  return FakeWorker.instances;
}

/**
 * Put a request in flight and answer it successfully, which is what now refills the
 * restart budget. The rejection is expected and swallowed: the worker is about to be
 * crashed out from under it in every test that uses this.
 */
function answerOneRequest(live: FakeWorker | undefined) {
  const inFlight = countFeatureCodesInWorker(Int32Array.from([1])).catch(() => undefined);
  const posted = live?.posted.at(-1) as { id: number } | undefined;
  if (posted) {
    live?.answer(posted.id);
  }
  return inFlight;
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
      answerOneRequest(live);
      live?.crash();
      expect(isParquetWorkerEnabled()).toBe(true);
      // Replaced each round, not merely left enabled: five crashes past a budget of
      // three only survive because answering refills it.
      expect(instances).toHaveLength(round + 2);
    }
  });

  it('does not let an error response refill the budget', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const instances = startWorker();

    // Responsive is not the same as working. A worker that errors on every request and
    // then crashes would otherwise refill its own budget forever.
    for (let round = 0; round < 5; round += 1) {
      const live = instances.at(-1);
      live?.signalReady();
      const inFlight = countFeatureCodesInWorker(Int32Array.from([1])).catch(() => undefined);
      const posted = live?.posted.at(-1) as { id: number } | undefined;
      live?.onmessage?.({
        data: {
          id: posted?.id ?? 0,
          direction: 'response',
          response: { ok: false, error: 'that store is poisoned' },
        },
      });
      void inFlight;
      live?.crash();
    }

    expect(isParquetWorkerEnabled()).toBe(false);
    expect(instances.length).toBeLessThanOrEqual(4);
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
    answerOneRequest(instances[0]);

    instances[0]?.crash();

    expect(instances).toHaveLength(2);
    expect(instances[0]?.terminated).toBe(true);
    expect(isParquetWorkerEnabled()).toBe(true);
  });
});
