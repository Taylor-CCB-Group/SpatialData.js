import { describe, expect, it } from 'vitest';
import * as zarr from 'zarrita';
import {
  getArrayDtype,
  getArrayMetadata,
  getChildArray,
  getChildGroup,
  getChildNode,
  getNodeAttrs,
  isLazyZarrArray,
  isTextDataType,
  isZarrGroup,
  normalizeDtype,
} from '../src/treeNodes';
import { ATTRS_KEY, ZARRAY_KEY, type ZarrTree } from '../src/types';

/**
 * The nodes here are shaped exactly as `openExtraConsolidated` builds them —
 * symbol-keyed metadata, a `get()` on leaves — because the whole point of the
 * guards is to tell those two apart at runtime, where the type system cannot.
 */
function arrayNode(metadata: Record<string, unknown>, attrs?: Record<string, unknown>) {
  return {
    ...(attrs ? { [ATTRS_KEY]: attrs } : {}),
    [ZARRAY_KEY]: metadata,
    get: () => Promise.reject(new Error('the guards must not touch the data')),
  };
}

describe('tree node guards', () => {
  it('tells an array leaf from a group', () => {
    const leaf = arrayNode({ data_type: 'float64' });
    const group = { [ATTRS_KEY]: { 'encoding-type': 'dataframe' }, leiden: leaf };

    expect(isLazyZarrArray(leaf)).toBe(true);
    expect(isZarrGroup(leaf)).toBe(false);

    expect(isZarrGroup(group)).toBe(true);
    expect(isLazyZarrArray(group)).toBe(false);
  });

  it('rejects non-nodes rather than reporting them as groups', () => {
    for (const value of [undefined, null, 'obs', 42, [], () => {}]) {
      expect(isZarrGroup(value)).toBe(false);
      expect(isLazyZarrArray(value)).toBe(false);
    }
  });

  it('reads attrs off either kind of node', () => {
    expect(getNodeAttrs(arrayNode({ dtype: '<f8' }, { 'encoding-type': 'array' }))).toEqual({
      'encoding-type': 'array',
    });
    expect(getNodeAttrs({ [ATTRS_KEY]: { _index: 'cell_id' } })).toEqual({ _index: 'cell_id' });
    expect(getNodeAttrs({})).toBeUndefined();
    expect(getNodeAttrs(undefined)).toBeUndefined();
  });
});

describe('child lookup', () => {
  const index = arrayNode({ data_type: 'string' });
  const tree = {
    tables: {
      cells: {
        [ATTRS_KEY]: { 'encoding-type': 'anndata' },
        obs: { [ATTRS_KEY]: { _index: '_index' }, _index: index },
      },
    },
  } satisfies ZarrTree;

  it('walks a path of groups to the node at the end', () => {
    expect(getChildGroup(tree, 'tables', 'cells', 'obs')).toBe(tree.tables.cells.obs);
    expect(getChildArray(tree, 'tables', 'cells', 'obs', '_index')).toBe(index);
    expect(getChildNode(tree, 'tables', 'cells', 'obs', '_index')).toBe(index);
  });

  it('does not confuse the two kinds', () => {
    // The bug the guards exist to stop: an array read as a group, its `get`
    // enumerated as if it were a child.
    expect(getChildGroup(tree, 'tables', 'cells', 'obs', '_index')).toBeUndefined();
    expect(getChildArray(tree, 'tables', 'cells', 'obs')).toBeUndefined();
  });

  it('stops at a missing step, and at an array in the middle of a path', () => {
    expect(getChildGroup(tree, 'images')).toBeUndefined();
    expect(getChildGroup(tree, 'tables', 'cells', 'obs', '_index', 'anything')).toBeUndefined();
  });

  it('walks own properties only', () => {
    // Otherwise `__proto__` resolves to `Object.prototype`, which has no
    // `ZARRAY_KEY` and so would pass for a group.
    expect(getChildGroup(tree, '__proto__')).toBeUndefined();
    expect(getChildNode(tree, 'constructor')).toBeUndefined();
  });
});

describe('array metadata and dtype', () => {
  it('reads metadata from an array leaf and nothing from a group', () => {
    expect(getArrayMetadata(arrayNode({ data_type: 'float64' }))).toEqual({
      data_type: 'float64',
    });
    expect(getArrayMetadata({ [ATTRS_KEY]: {} })).toBeUndefined();
  });

  it('reads both generations’ spelling of the same type', () => {
    // `data_type` is v3, `dtype` is v2 — the distinction every consumer would
    // otherwise have to know about.
    expect(getArrayDtype(arrayNode({ data_type: 'float64' }))).toBe('float64');
    expect(getArrayDtype(arrayNode({ dtype: '<f8' }))).toBe('float64');

    expect(getArrayDtype(arrayNode({ data_type: 'bool' }))).toBe('bool');
    expect(getArrayDtype(arrayNode({ dtype: '|b1' }))).toBe('bool');

    expect(getArrayDtype(arrayNode({ data_type: 'string' }))).toBe('string');
    expect(getArrayDtype(arrayNode({ dtype: '|O' }))).toBe('v2:object');
  });

  it('answers undefined for a group, and for a type it cannot name', () => {
    expect(getArrayDtype({ [ATTRS_KEY]: { 'encoding-type': 'categorical' } })).toBeUndefined();
    expect(getArrayDtype(arrayNode({}))).toBeUndefined();
    expect(getArrayDtype(arrayNode({ data_type: 'complex64' }))).toBeUndefined();
    // A v3 extension dtype is an object, not a string.
    expect(getArrayDtype(arrayNode({ data_type: { name: 'numpy.datetime64' } }))).toBeUndefined();
  });

  it('normalises v2 typestrings the way zarrita does', () => {
    expect(normalizeDtype('<i8')).toBe('int64');
    expect(normalizeDtype('>u4')).toBe('uint32');
    expect(normalizeDtype('<f2')).toBe('float16');
    expect(normalizeDtype('<U16')).toBe('v2:U16');
    expect(normalizeDtype('|S5')).toBe('v2:S5');
    expect(normalizeDtype('nonsense')).toBeUndefined();
  });

  it('does not answer with inherited properties of its lookup tables', () => {
    // The name comes out of a store, so it can be anything. An unguarded
    // `TABLE[name]` answers `constructor` with `Object` — truthy, so it escapes
    // as if it were a data type, and the next `dtype.startsWith` throws.
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(normalizeDtype(inherited)).toBeUndefined();
      expect(normalizeDtype(`<${inherited}`)).toBeUndefined();
      expect(getArrayDtype(arrayNode({ data_type: inherited }))).toBeUndefined();
      expect(getArrayDtype(arrayNode({ dtype: `<${inherited}` }))).toBeUndefined();
    }
  });

  /**
   * The reason to normalise into zarrita's vocabulary at all: a dtype read from
   * tree metadata and one read from an opened array have to be the same value,
   * or a check made before loading and the same check made after can disagree.
   */
  it('agrees with an opened array', async () => {
    const store = new Map<string, Uint8Array>();
    const encoder = new TextEncoder();
    store.set(
      '/zarr.json',
      encoder.encode(JSON.stringify({ zarr_format: 3, node_type: 'group', attributes: {} }))
    );
    const metadata = {
      zarr_format: 3,
      node_type: 'array',
      shape: [2],
      data_type: 'float64',
      chunk_grid: { name: 'regular', configuration: { chunk_shape: [2] } },
      chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
      codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
      fill_value: 0,
      attributes: {},
    };
    store.set('/scores/zarr.json', encoder.encode(JSON.stringify(metadata)));

    const opened = await zarr.open(zarr.root(store).resolve('/scores'), { kind: 'array' });
    expect(getArrayDtype(arrayNode(metadata))).toBe(opened.dtype);
  });
});

describe('isTextDataType', () => {
  it('covers every spelling of text, v2 object included', () => {
    for (const dtype of ['string', 'v2:object', 'v2:U16', 'v2:S5'] as const) {
      expect(isTextDataType(dtype)).toBe(true);
    }
  });

  it('is false for everything else', () => {
    for (const dtype of ['float64', 'int64', 'bool', 'uint8'] as const) {
      expect(isTextDataType(dtype)).toBe(false);
    }
  });

  it('matches what an opened array reports for the same values', async () => {
    // `v2:object` is the trap: zarrita's own `isDataType(dtype, 'string')` is
    // false for it, and testing only for `v2:object` misses v3's `string` —
    // either omission renders categorical labels as raw integer codes.
    const store = new Map<string, Uint8Array>();
    const encoder = new TextEncoder();
    store.set('/.zgroup', encoder.encode(JSON.stringify({ zarr_format: 2 })));
    store.set(
      '/categories/.zarray',
      encoder.encode(
        JSON.stringify({
          zarr_format: 2,
          shape: [2],
          chunks: [2],
          dtype: '|O',
          compressor: null,
          fill_value: null,
          filters: [{ id: 'vlen-utf8' }],
          order: 'C',
        })
      )
    );

    const opened = await zarr.open(zarr.root(store).resolve('/categories'), { kind: 'array' });
    expect(opened.dtype).toBe('v2:object');
    expect(isTextDataType(opened.dtype)).toBe(true);
    expect(opened.is('string')).toBe(false);
  });
});
