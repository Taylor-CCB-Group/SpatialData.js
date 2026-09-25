/**
 * Arrow's 64-bit integer lanes, which look like typed arrays but hold `bigint`.
 *
 * An `int64` column's `toArray()` is a `BigInt64Array`: a real `ArrayBuffer` view,
 * so it passes every "already typed, use it as is" test, while every element throws
 * on contact with a number. `Float32Array.prototype.set` rejects the whole array
 * ("Cannot mix BigInt and other types"), `Float32Array.from` rejects each element
 * ("Cannot convert a BigInt value to a number"), and plain arithmetic throws either
 * way. Integer coordinates are ordinary in the wild — pandas and dask write `x`/`y`
 * as `int64` unless told otherwise, which is what spatialdata's own `blobs_points`
 * does — so every path that reads a geometry or code column has to convert rather
 * than assume.
 */
export type BigIntLane = BigInt64Array | BigUint64Array;

function isBigIntLane(values: unknown): values is BigIntLane {
  return values instanceof BigInt64Array || values instanceof BigUint64Array;
}

/**
 * `values` as plain numbers: a {@link BigIntLane} widened into a `Float64Array`,
 * anything else returned untouched and zero-copy.
 *
 * Exact over the |v| < 2^53 range a coordinate or a feature code lives in. A 64-bit
 * *identifier* is a different question and wants `resolvePassthroughColumns`, which
 * refuses one rather than handing it back quietly rounded.
 *
 * The parameter is a union rather than `ArrayLike<unknown>` so that ruling out the
 * bigint lanes leaves `ArrayLike<number>` behind: the guard above is what makes the
 * return type true, instead of an assertion claiming it.
 */
export function toNumberValues(values: ArrayLike<number> | BigIntLane): ArrayLike<number> {
  if (isBigIntLane(values)) {
    const out = new Float64Array(values.length);
    for (let index = 0; index < values.length; index += 1) {
      out[index] = Number(values[index]);
    }
    return out;
  }
  return values;
}
