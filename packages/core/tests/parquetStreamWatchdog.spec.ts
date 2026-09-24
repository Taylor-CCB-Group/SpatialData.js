import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBatchWithinBudget, withinBudget } from '../src/parquetStreamWatchdog.js';
import { setParquetWorkerRequestTimeout } from '../src/workers/parquetWorkerClient.js';

/**
 * parquet-wasm answers a refused HTTP range by panicking and leaving its promise
 * unsettled. On the main thread there is no `error` event to notice, so an unguarded
 * `reader.read()` simply never returns: the caller hangs, takes no fallback, and logs
 * nothing. These tests pin the guard, not the panic.
 */
function hangingReader() {
  return {
    read: () => new Promise<never>(() => {}),
    cancel: vi.fn(() => Promise.resolve()),
  } as unknown as ReadableStreamDefaultReader<string> & { cancel: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  setParquetWorkerRequestTimeout(30_000);
  vi.useRealTimers();
});

describe('readBatchWithinBudget', () => {
  it('passes a batch straight through', async () => {
    const reader = {
      read: () => Promise.resolve({ done: false, value: 'batch' }),
      cancel: () => Promise.resolve(),
    } as unknown as ReadableStreamDefaultReader<string>;

    await expect(readBatchWithinBudget(reader, 'testing')).resolves.toEqual({
      done: false,
      value: 'batch',
    });
  });

  it('rejects rather than hanging when the reader goes silent', async () => {
    setParquetWorkerRequestTimeout(20);
    const reader = hangingReader();

    await expect(readBatchWithinBudget(reader, 'scanning for selected features')).rejects.toThrow(
      /went quiet for 20ms while scanning for selected features/
    );
  });

  it('cancels the abandoned stream so it stops fetching', async () => {
    setParquetWorkerRequestTimeout(20);
    const reader = hangingReader();

    await expect(readBatchWithinBudget(reader, 'testing')).rejects.toThrow();
    expect(reader.cancel).toHaveBeenCalled();
  });

  it('honours a disabled budget by waiting indefinitely', async () => {
    setParquetWorkerRequestTimeout(0);
    const reader = hangingReader();
    const settled = vi.fn();
    void readBatchWithinBudget(reader, 'testing').then(settled, settled);

    await new Promise((resolve) => setTimeout(resolve, 30));

    // 0 means "no watchdog" for the worker path; it has to mean the same here, or
    // turning the timeout off would change which reads are allowed to be slow.
    expect(settled).not.toHaveBeenCalled();
    expect(reader.cancel).not.toHaveBeenCalled();
  });
});

/**
 * `Promise.race` does not cancel its loser. A slow `ParquetFile.fromUrl()` or
 * `file.stream()` therefore keeps going after the watchdog has sent the caller to the
 * byte-oriented reader — a wasm handle that is never freed, or a stream that keeps
 * issuing range requests alongside the fallback that replaced it.
 */
describe('withinBudget', () => {
  it('passes a value straight through', async () => {
    await expect(withinBudget(Promise.resolve('opened'), 'testing')).resolves.toBe('opened');
  });

  it('rejects when the open never settles', async () => {
    setParquetWorkerRequestTimeout(20);
    await expect(withinBudget(new Promise<never>(() => {}), 'opening it')).rejects.toThrow(
      /went quiet for 20ms while opening it/
    );
  });

  it('releases a result that arrives after the timeout', async () => {
    setParquetWorkerRequestTimeout(20);
    const dispose = vi.fn();
    let settle: ((value: string) => void) | undefined;
    const slow = new Promise<string>((resolve) => {
      settle = resolve;
    });

    await expect(withinBudget(slow, 'opening it', dispose)).rejects.toThrow();
    expect(dispose).not.toHaveBeenCalled();

    // The open finally succeeds, long after the caller gave up on it.
    settle?.('a parquet file nobody asked for any more');
    await Promise.resolve();
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledWith('a parquet file nobody asked for any more');
  });

  it('does not release a result that arrives in time', async () => {
    const dispose = vi.fn();
    await expect(withinBudget(Promise.resolve('opened'), 'testing', dispose)).resolves.toBe(
      'opened'
    );
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('survives a late rejection without reporting it', async () => {
    setParquetWorkerRequestTimeout(20);
    const slow = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error('the open failed, eventually')), 60);
    });

    await expect(withinBudget(slow, 'opening it')).rejects.toThrow(/went quiet/);
    // An unhandled rejection here would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});
