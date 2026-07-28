import { type Location, type Readable, get as zarrGet, open as zarrOpen } from 'zarrita';
import type { TableValue } from '../types';

/**
 * AnnData's nullable encodings, which store a column as a *group* rather than an
 * array: a `values` array plus a boolean `mask` marking the null positions.
 *
 * Readers that open a column path as an array fail outright on these — the
 * symptom is a missing index rather than a missing value, because
 * `obs/_index` and `var/_index` are themselves ordinary columns. AnnData writes
 * this layout by default from 0.13 onwards (and `spatialdata` inherits it), so
 * it turns up in freshly written stores, not only in ones that have been
 * rewritten.
 *
 * See the AnnData on-disk specification, "Nullable integers, booleans and
 * strings" — all three share this group layout at encoding-version 0.1.0.
 */
export const NULLABLE_ENCODING_TYPES = new Set([
  'nullable-string-array',
  'nullable-integer',
  'nullable-boolean',
]);

export function isNullableEncoding(encodingType: unknown): boolean {
  return typeof encodingType === 'string' && NULLABLE_ENCODING_TYPES.has(encodingType);
}

/**
 * Read a nullable-encoded column into a flat array, with `null` at masked
 * positions.
 *
 * The mask is read alongside the values rather than ignored: a masked entry is
 * absent, not empty, and callers that render it (tooltips, legends) need to be
 * able to tell those apart.
 */
export async function readNullableArray(location: Location<Readable>): Promise<TableValue[]> {
  const valuesArray = await zarrOpen(location.resolve('values'), { kind: 'array' });
  const values = await zarrGet(valuesArray);

  // The specification requires a mask, but a values-only group is still
  // unambiguous, so read what is there rather than failing on a missing mask.
  let mask: boolean[] | undefined;
  try {
    const maskArray = await zarrOpen(location.resolve('mask'), { kind: 'array' });
    mask = toArray((await zarrGet(maskArray)).data).map(Boolean);
  } catch {
    mask = undefined;
  }

  return toArray(values.data).map((value, index) => (mask?.[index] ? null : value));
}

/**
 * Materialise a zarrita chunk as a plain array.
 *
 * Zarrita returns several backing types — native TypedArrays plus its own
 * `BoolArray`/`ByteStringArray`/`UnicodeStringArray`. They are all iterable but
 * do not share an indexable interface, so the union has no common supertype to
 * narrow to; iterating is the one operation defined across all of them.
 */
function toArray(data: unknown): TableValue[] {
  return Array.from(data as Iterable<TableValue>);
}
