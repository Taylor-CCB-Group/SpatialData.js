/**
 * The per-feature inputs a Renderer Adapter rebuilds its feature-state projections from, held
 * by reference so the adapter can tell an unchanged call in O(1).
 *
 * `getLayers()` runs on every render, camera moves included, and each entry's projections are
 * checked on every call. A check that serialises the id lists (sort, then join or
 * `JSON.stringify`) costs O(n log n) per layer per frame even when nothing changed, which is
 * every frame of a pan. Several layers over one element (a small multiple per category, each
 * hiding most of the features) multiply it. So these compare by identity first, and only on
 * an identity miss walk the contents, without allocating a string for them.
 *
 * Contents still decide, so a host that rebuilds an equal list per render keeps its cache;
 * {@link sameFeatureStateInputs} then hands back the new references, so the next call with
 * the same arrays is an identity hit again. A list mutated in place is not seen — hosts
 * replace feature-state values rather than editing them (see `layer-prop-flow.mdx`).
 */

type Rgba = readonly [number, number, number, number];
type ColorByFeatureId = Readonly<Record<string, Rgba>>;

export interface FeatureStateInputs {
  hiddenFeatureIds: readonly string[] | undefined;
  fadedFeatureIds: readonly string[] | undefined;
  filteredOpacityMultiplier: number | undefined;
  fillColorByFeatureId: ColorByFeatureId | undefined;
  strokeColorByFeatureId: ColorByFeatureId | undefined;
}

export function featureStateInputs(
  featureState:
    | {
        hiddenFeatureIds?: readonly string[];
        fadedFeatureIds?: readonly string[];
        filteredOpacityMultiplier?: number;
        fillColorByFeatureId?: ColorByFeatureId;
        strokeColorByFeatureId?: ColorByFeatureId;
      }
    | undefined
): FeatureStateInputs {
  return {
    hiddenFeatureIds: featureState?.hiddenFeatureIds,
    fadedFeatureIds: featureState?.fadedFeatureIds,
    filteredOpacityMultiplier: featureState?.filteredOpacityMultiplier,
    fillColorByFeatureId: featureState?.fillColorByFeatureId,
    strokeColorByFeatureId: featureState?.strokeColorByFeatureId,
  };
}

/**
 * Whether `next` holds what `cached` does. On a match the cached references are replaced
 * with `next`'s, so a host passing the same arrays from now on compares in O(1).
 */
export function sameFeatureStateInputs(
  cached: FeatureStateInputs,
  next: FeatureStateInputs
): boolean {
  if (
    cached.filteredOpacityMultiplier !== next.filteredOpacityMultiplier ||
    !sameIdList(cached.hiddenFeatureIds, next.hiddenFeatureIds) ||
    !sameIdList(cached.fadedFeatureIds, next.fadedFeatureIds) ||
    !sameColorByFeatureId(cached.fillColorByFeatureId, next.fillColorByFeatureId) ||
    !sameColorByFeatureId(cached.strokeColorByFeatureId, next.strokeColorByFeatureId)
  ) {
    return false;
  }
  Object.assign(cached, next);
  return true;
}

/**
 * Whether two id lists hold the same ids, in any order (duplicates counted, as a sorted
 * comparison would). No list and an empty one are the same.
 */
export function sameIdList(a: readonly string[] | undefined, b: readonly string[] | undefined) {
  if (a === b) return true;
  const length = a?.length ?? 0;
  if (length !== (b?.length ?? 0)) return false;
  if (!a || !b || length === 0) return true;
  // A host rebuilding the same list usually rebuilds it in the same order.
  let first = 0;
  while (first < length && a[first] === b[first]) first++;
  if (first === length) return true;
  const counts = new Map<string, number>();
  for (let i = first; i < length; i++) counts.set(a[i], (counts.get(a[i]) ?? 0) + 1);
  for (let i = first; i < length; i++) {
    const count = counts.get(b[i]);
    if (!count) return false;
    counts.set(b[i], count - 1);
  }
  return true;
}

/** Whether two per-feature colour records give every feature the same colour. */
export function sameColorByFeatureId(
  a: ColorByFeatureId | undefined,
  b: ColorByFeatureId | undefined
) {
  if (a === b) return true;
  const aKeys = a ? Object.keys(a) : [];
  const bKeys = b ? Object.keys(b) : [];
  if (aKeys.length !== bKeys.length) return false;
  if (!a || !b) return true;
  for (const key of aKeys) {
    const colour = a[key];
    const other = b[key];
    if (!other || colour.length !== other.length) return false;
    for (let i = 0; i < colour.length; i++) if (colour[i] !== other[i]) return false;
  }
  return true;
}
