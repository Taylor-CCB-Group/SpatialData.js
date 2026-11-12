import { getChannelStats } from '@hms-dbmi/viv';

type VivTypedArray = Parameters<typeof getChannelStats>[0];
type SmallIntArray = Uint8Array | Uint8ClampedArray | Int8Array | Uint16Array | Int16Array;

// Must match the cutoff hard-coded in Viv's getChannelStats.
const CUTOFF_PERCENTILE = 0.0005;

function isSmallIntArray(data: unknown): data is SmallIntArray {
  return (
    data instanceof Uint8Array ||
    data instanceof Uint8ClampedArray ||
    data instanceof Int8Array ||
    data instanceof Uint16Array ||
    data instanceof Int16Array
  );
}

/**
 * Viv's `domain` and `contrastLimits` for a channel raster.
 *
 * 8/16-bit integers use a counting histogram: exact same values as Viv's
 * quickselect, ~20x faster, and `data` is not reordered. Other dtypes defer to
 * Viv, which reorders `data` in place.
 */
export function computeChannelStats(data: VivTypedArray): {
  domain: number[];
  contrastLimits: number[];
} {
  if (!isSmallIntArray(data)) return getChannelStats(data);

  const signed = data instanceof Int8Array || data instanceof Int16Array;
  const bins = data.BYTES_PER_ELEMENT === 1 ? 256 : 65536;
  const offset = signed ? bins / 2 : 0;
  const hist = new Uint32Array(bins);
  for (let i = 0; i < data.length; i++) hist[data[i] + offset]++;

  let lo = 0;
  while (lo < bins && hist[lo] === 0) lo++;
  // Viv's result for an empty array.
  if (lo === bins) return { domain: [Infinity, -Infinity], contrastLimits: [0, 0] };
  let hi = bins - 1;
  while (hist[hi] === 0) hi--;

  // Viv takes the cutoffs over strictly positive values only.
  const firstPositive = offset + 1;
  let positives = 0;
  for (let b = firstPositive; b < bins; b++) positives += hist[b];
  const kth = (k: number) => {
    let seen = 0;
    for (let b = firstPositive; b < bins; b++) {
      seen += hist[b];
      if (seen > k) return b - offset;
    }
    return 0;
  };
  const top = Math.floor(positives * (1 - CUTOFF_PERCENTILE));
  const bottom = Math.floor(positives * CUTOFF_PERCENTILE);

  return {
    domain: [lo - offset, hi - offset],
    contrastLimits: [kth(bottom), kth(top)],
  };
}
