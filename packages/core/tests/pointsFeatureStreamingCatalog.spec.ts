import { Dictionary, Int32, tableFromArrays, Utf8, vectorFromArray } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import {
  accumulateFeatureCatalogFromTable,
  featureCatalogFromCodeMap,
} from '../src/pointsFeatures.js';
import { supportsParquetStreaming } from '../src/parquetWasmLoader.js';

const FEATURE_KEY = 'feature_name';

/** A dictionary-typed feature column — the case row-group reads cannot decode. */
function dictionaryFeatureTable(names: string[]) {
  return tableFromArrays({
    [FEATURE_KEY]: vectorFromArray(names, new Dictionary(new Utf8(), new Int32())),
  });
}

function catalogFromWholeTable(names: string[]) {
  const codeToName = new Map<number, string>();
  const nameToCode = new Map<string, number>();
  accumulateFeatureCatalogFromTable(
    codeToName,
    nameToCode,
    dictionaryFeatureTable(names),
    FEATURE_KEY,
    undefined
  );
  return featureCatalogFromCodeMap(FEATURE_KEY, codeToName);
}

/** Accumulate in batches, capturing the catalog after each — what streaming does. */
function catalogsFromBatches(names: string[], batchSize: number) {
  const codeToName = new Map<number, string>();
  const nameToCode = new Map<string, number>();
  const partials = [];
  for (let offset = 0; offset < names.length; offset += batchSize) {
    accumulateFeatureCatalogFromTable(
      codeToName,
      nameToCode,
      dictionaryFeatureTable(names.slice(offset, offset + batchSize)),
      FEATURE_KEY,
      undefined
    );
    partials.push(featureCatalogFromCodeMap(FEATURE_KEY, codeToName));
  }
  return partials;
}

// Features clustered so later batches introduce genuinely new names — otherwise
// every batch would see every feature and the prefix property would be trivial.
const NAMES = [
  ...Array.from({ length: 40 }, (_v, i) => `early_${i % 4}`),
  ...Array.from({ length: 40 }, (_v, i) => `mid_${i % 5}`),
  ...Array.from({ length: 40 }, (_v, i) => `late_${i % 3}`),
];

describe('streaming feature catalog code space', () => {
  it('assigns the same codes batch-by-batch as it does whole-table', () => {
    const whole = catalogFromWholeTable(NAMES);
    const partials = catalogsFromBatches(NAMES, 16);
    const final = partials[partials.length - 1];

    expect(final.entries).toEqual(whole.entries);
  });

  it('never reassigns a code as later batches arrive', () => {
    const partials = catalogsFromBatches(NAMES, 16);

    // Each partial must be a prefix-consistent view: every entry it publishes
    // keeps the same code in every later partial. This is what makes it safe for
    // the panel to render (and the user to select from) a partial catalog.
    const final = partials[partials.length - 1];
    const finalByName = new Map(final.entries.map((entry) => [entry.name, entry.code]));
    for (const partial of partials) {
      for (const entry of partial.entries) {
        expect(finalByName.get(entry.name)).toBe(entry.code);
      }
    }
  });

  it('grows monotonically and reaches the full feature set', () => {
    const partials = catalogsFromBatches(NAMES, 16);

    for (let i = 1; i < partials.length; i += 1) {
      expect(partials[i].entries.length).toBeGreaterThanOrEqual(partials[i - 1].entries.length);
    }
    expect(partials[0].entries.length).toBeLessThan(new Set(NAMES).size);
    expect(partials[partials.length - 1].entries.length).toBe(new Set(NAMES).size);
  });

  it('is independent of batch size', () => {
    const reference = catalogFromWholeTable(NAMES);
    for (const batchSize of [1, 7, 16, 64, 1000]) {
      const partials = catalogsFromBatches(NAMES, batchSize);
      expect(partials[partials.length - 1].entries).toEqual(reference.entries);
    }
  });
});

describe('supportsParquetStreaming', () => {
  it('is false under Node so tests and SSR keep the byte-oriented reads', () => {
    // The streaming reader panics under Node with an async `RuntimeError:
    // unreachable` that escapes try/catch, so this guard cannot be probed
    // defensively — it has to stay false here.
    expect(supportsParquetStreaming()).toBe(false);
  });
});
