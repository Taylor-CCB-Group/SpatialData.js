import { afterEach, describe, expect, it, vi } from 'vitest';
import SpatialDataPointsSource from '../src/models/VPointsSource.js';

/**
 * The range probe caches its answer per ORIGIN, for the life of the page, and a
 * `false` demotes every element on that origin to the whole-file read path.
 *
 * That makes the difference between "the server said no" and "the request did
 * not complete" load-bearing. Caching the second reads, from the outside, as a
 * non-deterministic failure: one dropped connection during startup and points
 * or feature counts never settle again until a hard reload — with nothing in the
 * log to say why, because the fallback path looks healthy.
 *
 * These pin that only a DEFINITIVE answer sticks.
 */

type Internals = {
  serverSupportsStreamingRanges: (url: string) => Promise<boolean>;
};

const url = 'http://example.test/points/transcripts/points.parquet';

function probeSource() {
  const source = new SpatialDataPointsSource({
    store: { async get() {}, async getRange() {} },
    fileType: '.zarr',
  } as never);
  return source as unknown as Internals;
}

/** The static cache outlives any one instance, so each case needs a fresh origin. */
function freshUrl(name: string) {
  return `http://${name}.test/points.parquet`;
}

function partialResponse(byteLength: number) {
  return {
    status: 206,
    arrayBuffer: async () => new ArrayBuffer(byteLength),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streaming range probe — cache policy', () => {
  it('caches a successful probe so the second call issues no requests', async () => {
    const fetchSpy = vi.fn(async () => partialResponse(8));
    vi.stubGlobal('fetch', fetchSpy);
    const target = freshUrl('cache-ok');

    await expect(probeSource().serverSupportsStreamingRanges(target)).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // suffix + bounded

    // A different instance, same origin: the answer is a property of the server.
    await expect(probeSource().serverSupportsStreamingRanges(target)).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('caches a definitive refusal — a 416 server should not be re-probed forever', async () => {
    const fetchSpy = vi.fn(async () => ({ status: 416 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    const target = freshUrl('cache-416');

    await expect(probeSource().serverSupportsStreamingRanges(target)).resolves.toBe(false);
    await expect(probeSource().serverSupportsStreamingRanges(target)).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache a thrown probe, so a transient failure can recover', async () => {
    let attempt = 0;
    const fetchSpy = vi.fn(async () => {
      attempt += 1;
      // Both requests of the first probe fail; everything after succeeds.
      if (attempt <= 2) throw new TypeError('Failed to fetch');
      return partialResponse(8);
    });
    vi.stubGlobal('fetch', fetchSpy);
    const target = freshUrl('transient');

    await expect(probeSource().serverSupportsStreamingRanges(target)).resolves.toBe(false);
    // Without eviction this stays false for the life of the page.
    await expect(probeSource().serverSupportsStreamingRanges(target)).resolves.toBe(true);
  });

  it('still shares one in-flight probe between concurrent callers', async () => {
    const fetchSpy = vi.fn(async () => partialResponse(8));
    vi.stubGlobal('fetch', fetchSpy);
    const target = freshUrl('inflight');
    const source = probeSource();

    const [first, second] = await Promise.all([
      source.serverSupportsStreamingRanges(target),
      source.serverSupportsStreamingRanges(target),
    ]);
    expect([first, second]).toEqual([true, true]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('treats a short body as a refusal — the reader would read the wrong window', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => partialResponse(4)));
    await expect(probeSource().serverSupportsStreamingRanges(freshUrl('short'))).resolves.toBe(
      false
    );
  });

  it('declines a non-URL target without probing', async () => {
    const fetchSpy = vi.fn(async () => partialResponse(8));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(probeSource().serverSupportsStreamingRanges('not a url')).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
