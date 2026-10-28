/**
 * What a picked point carries, and how a tooltip reads it.
 *
 * The scatter layer is fed BINARY attributes, not an array of objects (see
 * `pointsRenderAttributes`), and deck only fills `info.object` when `props.data`
 * is indexable — so a points pick arrives as a bare row index with nothing on it.
 * `PointsScatterplotLayer.getPickingInfo` reads the row back out of the very
 * buffers it drew from and attaches it as {@link PointsPickObject}; everything
 * downstream (hover tooltips, host pick callbacks) sees the same shape a shapes
 * or labels pick has.
 *
 * The index is per DRAWN BATCH, which on the tiled path is one tile — it is not a
 * row number in the element, so it identifies nothing durable and is deliberately
 * absent from the tooltip. Position and feature code are the parts that mean
 * something on both paths.
 */

import type { PointsFeatureEntry } from '@spatialdata/core';

export const POINTS_PICK_KIND = 'spatialdata-points' as const;

export interface PointsPickObject {
  kind: typeof POINTS_PICK_KIND;
  /** Row index within the drawn batch (a single tile's batch on the tiled path). */
  pointIndex: number;
  /** Position in the element's own coordinate space, before `modelMatrix`. */
  position: [number, number, number];
  /**
   * The point's feature code, or `undefined` when the batch carries no codes (or
   * carries the extension's -1 "no code" default).
   */
  featureCode?: number;
}

export function isPointsPickObject(value: unknown): value is PointsPickObject {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (
    Reflect.get(value, 'kind') !== POINTS_PICK_KIND ||
    typeof Reflect.get(value, 'pointIndex') !== 'number'
  ) {
    return false;
  }
  // `position` is checked too, not taken on the kind's word: a caller that reads a
  // narrowed pick destructures it, so a guard that waves through a half-built object
  // turns a wrong shape into a throw inside the tooltip.
  const position = Reflect.get(value, 'position');
  return (
    Array.isArray(position) &&
    position.length === 3 &&
    position.every((coordinate) => typeof coordinate === 'number')
  );
}

/**
 * One of the layer's binary attributes, or `undefined` when it isn't there in the
 * shape we wrote it. `instanceof Float32Array` narrows without an assertion, and
 * is exact: {@link buildPointsDeckData} only ever supplies Float32Arrays.
 */
function readFloat32Attribute(
  data: unknown,
  name: string
): { value: Float32Array; size: number } | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const attributes = Reflect.get(data, 'attributes');
  if (!attributes || typeof attributes !== 'object') {
    return undefined;
  }
  const attribute = Reflect.get(attributes, name);
  if (!attribute || typeof attribute !== 'object') {
    return undefined;
  }
  const value = Reflect.get(attribute, 'value');
  const size = Reflect.get(attribute, 'size');
  if (!(value instanceof Float32Array) || typeof size !== 'number' || size <= 0) {
    return undefined;
  }
  return { value, size };
}

/** A typed array or plain array of numbers, narrowed without an assertion. */
function isNumericArrayLike(value: unknown): value is ArrayLike<number> {
  if (Array.isArray(value)) {
    return true;
  }
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function readPickFeatureCodes(
  data: unknown
): { value: ArrayLike<number>; size: number } | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const value = Reflect.get(data, 'pickFeatureCodes');
  return isNumericArrayLike(value) ? { value, size: 1 } : undefined;
}

/** Rebuild the picked row from the binary `data` prop the scatter layer drew. */
export function pointsPickObjectFromDeckData(
  data: unknown,
  index: number
): PointsPickObject | undefined {
  if (!Number.isInteger(index) || index < 0) {
    return undefined;
  }
  const positions = readFloat32Attribute(data, 'getPosition');
  if (!positions) {
    return undefined;
  }
  const base = index * positions.size;
  if (base + positions.size > positions.value.length) {
    return undefined;
  }
  const x = positions.value[base];
  const y = positions.value[base + 1];
  const z = positions.size >= 3 ? positions.value[base + 2] : 0;

  // The drawn attribute when colour-by-feature is on, else the CPU-side lane the
  // deck data carries for exactly this (see `PointsDeckData.pickFeatureCodes`), so
  // the tooltip names the feature whether or not the layer is colouring by it.
  const codes = readFloat32Attribute(data, 'getFeatureCode') ?? readPickFeatureCodes(data);
  const rawCode = codes && index < codes.value.length ? codes.value[index] : undefined;
  // -1 is the extension's "no code" default (see pointsScatterLayer), not a feature.
  const featureCode = rawCode !== undefined && rawCode >= 0 ? rawCode : undefined;

  return {
    kind: POINTS_PICK_KIND,
    pointIndex: index,
    position: [x, y, z],
    ...(featureCode !== undefined ? { featureCode } : {}),
  };
}

/**
 * Positions are Float32, so printing them raw spells a micron as `123.45600128173828`.
 * Six significant digits is past the precision the buffer holds and still reads as a
 * coordinate; trailing zeros go, so a round number stays round.
 */
function formatCoordinate(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  return Number(value.toPrecision(6)).toString();
}

export interface PointsTooltipFeature {
  /** The element's feature column name (`feature_name`, `gene`, …), for the item label. */
  featureKey?: string;
  /** The picked code's catalog entry, when the catalog has settled and holds it. */
  entry?: Pick<PointsFeatureEntry, 'name'>;
}

/**
 * Tooltip content for a picked point: which feature it is, and where it is.
 *
 * The feature line is the reason anyone hovers a transcript, so it leads and it is
 * also the title. A code with no catalog entry still shows — a catalog that is
 * mid-scan is exactly when "which gene is this?" is being asked, and `code 41` at
 * least says the two points under the cursor differ.
 */
export function formatPointsTooltip(
  pick: PointsPickObject,
  feature: PointsTooltipFeature = {}
): { title?: string; items: Array<{ label: string; value: string }> } {
  const items: Array<{ label: string; value: string }> = [];
  const name = feature.entry?.name;
  if (name !== undefined) {
    items.push({ label: feature.featureKey ?? 'feature', value: name });
  } else if (pick.featureCode !== undefined) {
    items.push({ label: feature.featureKey ?? 'feature', value: `code ${pick.featureCode}` });
  }

  const [x, y, z] = pick.position;
  items.push({ label: 'x', value: formatCoordinate(x) });
  items.push({ label: 'y', value: formatCoordinate(y) });
  // z is 0 for every point on a 2D element (`use3d` off), where a row of zeroes is noise.
  if (z !== 0) {
    items.push({ label: 'z', value: formatCoordinate(z) });
  }

  return { ...(name !== undefined ? { title: name } : {}), items };
}
