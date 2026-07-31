/**
 * Runtime discrimination for {@link ZarrTree} nodes.
 *
 * `ZarrTree`'s index signature admits a group or an array at every key, and a
 * `LazyZarrArray` is an object too — so the obvious `typeof node === 'object'`
 * test lets an array through, after which its own properties (`get`) read as if
 * they were child keys. `zarrita`'s own guards do not apply here: these are
 * consolidated-metadata tree nodes, not open `zarr.Array`/`zarr.Group` handles.
 *
 * The discriminator is {@link ZARRAY_KEY}, required on every array leaf and
 * absent from every group.
 */

import type * as zarr from 'zarrita';
import type { LazyZarrArray, ZAttrsAny, ZarrArrayMetadata, ZarrTree } from './types';
import { ATTRS_KEY, ZARRAY_KEY } from './types';

/**
 * The data types this package can name.
 *
 * `zarrita`'s own `DataType` is the vocabulary — with `float16` added back,
 * because `zarrita` admits that member only when the type environment declares
 * `Float16Array`, which an `ES2022` lib does not. The name still appears in real
 * stores and is still worth classifying, and where `Float16Array` *is* declared
 * this union is exactly `zarr.DataType`.
 */
export type ZarrDataType = zarr.DataType | 'float16';

function isPlainNode(node: unknown): node is Record<string | symbol, unknown> {
  return typeof node === 'object' && node !== null && !Array.isArray(node);
}

/**
 * Whether a tree node is an array leaf — something with data behind a `get()`.
 */
export function isLazyZarrArray(node: unknown): node is LazyZarrArray<zarr.DataType> {
  return isPlainNode(node) && ZARRAY_KEY in node;
}

/**
 * Whether a tree node is a group — a node whose string keys are children.
 *
 * This is the complement of {@link isLazyZarrArray} within a tree, so it says
 * "not an array leaf" rather than "provably a group": any object that is not an
 * array node is walkable as one, which is what callers enumerating children
 * need. Pair it with an existence check when the node may be absent.
 */
export function isZarrGroup(node: unknown): node is ZarrTree {
  return isPlainNode(node) && !(ZARRAY_KEY in node);
}

/**
 * The attributes of any tree node, group or array, or `undefined` when it has
 * none.
 */
export function getNodeAttrs(node: unknown): ZAttrsAny | undefined {
  if (!isPlainNode(node)) return undefined;
  const attrs = node[ATTRS_KEY];
  return isPlainNode(attrs) ? attrs : undefined;
}

/**
 * The node at `path` below `node`, or `undefined` if any step is missing or a
 * step other than the last turns out to be an array.
 *
 * Own properties only: `getChildNode(tree, '__proto__')` must not walk into
 * `Object.prototype` and report it as a group.
 */
export function getChildNode(
  node: unknown,
  ...path: string[]
): ZarrTree | LazyZarrArray<zarr.DataType> | undefined {
  let current: unknown = node;
  for (const segment of path) {
    if (!isZarrGroup(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  if (isLazyZarrArray(current)) return current;
  return isZarrGroup(current) ? current : undefined;
}

/**
 * The child group at `path`, or `undefined` when it is absent or is an array.
 *
 * This is the shape most consumers actually want: "the `obs` group of this
 * table, if it really is a group".
 */
export function getChildGroup(node: unknown, ...path: string[]): ZarrTree | undefined {
  const child = getChildNode(node, ...path);
  return isZarrGroup(child) ? child : undefined;
}

/**
 * The child array at `path`, or `undefined` when it is absent or is a group.
 */
export function getChildArray(
  node: unknown,
  ...path: string[]
): LazyZarrArray<zarr.DataType> | undefined {
  const child = getChildNode(node, ...path);
  return isLazyZarrArray(child) ? child : undefined;
}

/**
 * The array metadata of a tree node, or `undefined` when the node is not an
 * array leaf.
 */
export function getArrayMetadata(node: unknown): ZarrArrayMetadata | undefined {
  return isLazyZarrArray(node) ? node[ZARRAY_KEY] : undefined;
}

/**
 * v2 numpy typestrings, minus the endianness prefix, in `zarrita`'s vocabulary.
 *
 * Mirrors `zarrita`'s own internal `coerceDtype`, which is not exported. The
 * point of matching it is that {@link getArrayDtype} and an opened array's
 * `dtype` must name the same type for the same store — otherwise a check made
 * against tree metadata and the same check made after opening can disagree.
 */
const V2_DTYPE_NAMES: Record<string, ZarrDataType> = {
  b1: 'bool',
  i1: 'int8',
  u1: 'uint8',
  i2: 'int16',
  u2: 'uint16',
  i4: 'int32',
  u4: 'uint32',
  i8: 'int64',
  u8: 'uint64',
  f2: 'float16',
  f4: 'float32',
  f8: 'float64',
};

/**
 * v3 data type names, mapped to themselves so a lookup both recognises the name
 * and types it — a `Set` would recognise it and leave an assertion behind.
 * Unlisted names (`complex64`, the `r*` raw types, extension dtypes) are ones
 * `zarrita` cannot read either, so `undefined` is the honest answer.
 */
const V3_DTYPE_NAMES: Record<string, ZarrDataType> = {
  bool: 'bool',
  int8: 'int8',
  int16: 'int16',
  int32: 'int32',
  int64: 'int64',
  uint8: 'uint8',
  uint16: 'uint16',
  uint32: 'uint32',
  uint64: 'uint64',
  float16: 'float16',
  float32: 'float32',
  float64: 'float64',
  string: 'string',
};

/**
 * Normalise either generation's spelling of a data type to a
 * {@link ZarrDataType}, or `undefined` for one we do not model.
 *
 * Deliberately not a bare string: the answer is meant to be comparable with an
 * opened array's `dtype`, so the two layers agree by construction rather than by
 * coincidence.
 */
export function normalizeDtype(dtype: string): ZarrDataType | undefined {
  const v3 = V3_DTYPE_NAMES[dtype];
  if (v3) return v3;

  // `|O` is the one v2 typestring whose meaning is not in the table below.
  if (dtype === '|O') return 'v2:object';

  const match = /^[<>|=](.+)$/.exec(dtype);
  if (!match) return undefined;
  const rest = match[1];

  const named = V2_DTYPE_NAMES[rest];
  if (named) return named;

  // Fixed-width bytes (`S`) and unicode (`U`), which zarrita keeps as-is behind
  // a `v2:` prefix because v3 has no equivalent.
  const fixedWidth = /^([SU])(\d+)$/.exec(rest);
  if (fixedWidth) {
    const width = Number(fixedWidth[2]);
    return fixedWidth[1] === 'S' ? `v2:S${width}` : `v2:U${width}`;
  }

  return undefined;
}

/**
 * The data type of an array node, from consolidated metadata alone — no I/O, and
 * without the array having been opened.
 *
 * The field name differs by generation (`dtype` on v2, `data_type` on v3) and
 * both reach the tree, so every consumer that wants a dtype would otherwise have
 * to know that. `undefined` for a group, or for a data type we do not model.
 */
export function getArrayDtype(node: unknown): ZarrDataType | undefined {
  const metadata = getArrayMetadata(node);
  if (!metadata) return undefined;

  const spelling = 'data_type' in metadata ? metadata.data_type : metadata.dtype;
  return typeof spelling === 'string' ? normalizeDtype(spelling) : undefined;
}

/**
 * Whether values of this data type are text, and so need decoding to strings.
 *
 * Covers v3 `string` and v2's fixed-width unicode/bytes *and* `object`.
 * `zarrita`'s `isDataType(dtype, 'string')` deliberately excludes `v2:object`,
 * which has to be tested separately — testing for one without the other is what
 * makes a reader return raw integer codes where labels were expected, with no
 * error anywhere. Written once here so both the tree-metadata layer and the
 * opened-array layer can ask the same question.
 */
export function isTextDataType(dtype: ZarrDataType): boolean {
  return (
    dtype === 'string' ||
    dtype === 'v2:object' ||
    dtype.startsWith('v2:U') ||
    dtype.startsWith('v2:S')
  );
}
