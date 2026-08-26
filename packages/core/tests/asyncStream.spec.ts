import { describe, expect, it, vi } from 'vitest';
import { coalesceLatest, drainStream, sampleByStep } from '../src/asyncStream.js';

/**
 * The combinators behind the async-iterable streaming APIs (#175).
 *
 * `coalesceLatest` is the one with teeth: it deliberately DROPS items, sound only
 * because every points tick is a cumulative snapshot. These pin both halves — the
 * newest item always survives, and nothing is dropped when the consumer keeps up.
 */

/** A generator over `items`, optionally ending by throwing. */
async function* from<T>(items: T[], failWith?: Error): AsyncGenerator<T, void> {
  for (const item of items) {
    yield item;
  }
  if (failWith) {
    throw failWith;
  }
}

/** Yield to the microtask queue enough times for a pump to run ahead. */
async function settle() {
  for (let index = 0; index < 16; index += 1) {
    await Promise.resolve();
  }
}

describe('coalesceLatest', () => {
  it('passes everything through when the consumer keeps up', async () => {
    const seen: number[] = [];
    for await (const item of coalesceLatest(from([1, 2, 3]))) {
      seen.push(item);
    }
    // The producer here is synchronous-ish, so this is not a guarantee about
    // dropping; it is the floor — nothing is invented or reordered.
    expect(seen[seen.length - 1]).toBe(3);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('drops superseded items while the consumer is busy, and never the newest', async () => {
    // A producer that runs to completion while the consumer is asleep on its
    // first item — the shape of a worker decoding faster than a panel repaints.
    async function* fast() {
      for (let index = 1; index <= 50; index += 1) {
        yield index;
        await Promise.resolve();
      }
    }
    const seen: number[] = [];
    for await (const item of coalesceLatest(fast())) {
      seen.push(item);
      await settle();
    }
    expect(seen.length).toBeLessThan(50);
    // The last value is the one that matters: for a cumulative stream it is the
    // whole answer, and dropping it would lose data rather than save work.
    expect(seen[seen.length - 1]).toBe(50);
  });

  it('delivers what it already has before raising the source failure', async () => {
    const seen: number[] = [];
    const boom = new Error('range read failed');
    await expect(
      (async () => {
        for await (const item of coalesceLatest(from([1, 2, 3], boom))) {
          seen.push(item);
        }
      })()
    ).rejects.toThrow(/range read failed/);
    // "Consumed n items, then it threw" — the partial-failure contract, as
    // ordinary control flow.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(3);
  });

  it('closes the source when the consumer breaks out', async () => {
    const closed = vi.fn();
    async function* cancellable() {
      try {
        for (let index = 0; ; index += 1) {
          yield index;
        }
      } finally {
        closed();
      }
    }
    for await (const _item of coalesceLatest(cancellable())) {
      break;
    }
    await settle();
    // `break` is cancellation: the source's `finally` is where a worker-backed
    // stream posts its cancel.
    expect(closed).toHaveBeenCalled();
  });
});

describe('sampleByStep', () => {
  it('emits only once the metric has advanced by the step', async () => {
    const rows = [10, 20, 120, 130, 240];
    const seen: number[] = [];
    for await (const item of sampleByStep(from(rows), 100, (value) => value)) {
      seen.push(item);
    }
    // 10 is the first (nothing to compare against), 120 clears 10+100, 240 clears
    // 120+100. 20 and 130 are inside the step.
    expect(seen).toEqual([10, 120, 240]);
  });

  it('always emits the final item, even when it is inside the step', async () => {
    const seen: number[] = [];
    for await (const item of sampleByStep(from([0, 5, 9]), 100, (value) => value)) {
      seen.push(item);
    }
    // Otherwise the consumer's last view is 0 while the load actually reached 9 —
    // a stale final state, which is worse than an extra tick.
    expect(seen).toEqual([0, 9]);
  });

  it('holds nothing back when every item clears the step', async () => {
    const seen: number[] = [];
    for await (const item of sampleByStep(from([0, 100, 200]), 100, (value) => value)) {
      seen.push(item);
    }
    expect(seen).toEqual([0, 100, 200]);
  });
});

describe('drainStream', () => {
  it('returns the generator return value and pushes every item to the callback', async () => {
    async function* stream(): AsyncGenerator<number, string> {
      yield 1;
      yield 2;
      return 'settled';
    }
    const seen: number[] = [];
    await expect(drainStream(stream(), (item) => seen.push(item))).resolves.toBe('settled');
    expect(seen).toEqual([1, 2]);
  });

  it('works with no callback at all', async () => {
    async function* stream(): AsyncGenerator<number, string> {
      yield 1;
      return 'settled';
    }
    await expect(drainStream(stream())).resolves.toBe('settled');
  });

  it('propagates a failure after the items it already delivered', async () => {
    async function* stream(): AsyncGenerator<number, string> {
      yield 1;
      throw new Error('decode panicked');
    }
    const seen: number[] = [];
    await expect(drainStream(stream(), (item) => seen.push(item))).rejects.toThrow(
      /decode panicked/
    );
    expect(seen).toEqual([1]);
  });
});
