/**
 * A value key over the layer-config fields that drive LOADING.
 *
 * `useLayerData`'s reconcile effect is the one place a config change turns into a
 * request to the Resource Resolver. Keying that effect on the identity of `layers`
 * (or of the configs inside it) assumes the caller allocates a fresh config object
 * per edit — and one important caller does the opposite on purpose.
 *
 * MDV's render-stack adapter keeps ONE `LayerConfig` object per Stack Entry and
 * patches it in place, so that a cosmetic edit (opacity, a channel colour) does not
 * look like a structural change and re-enter async geometry loads. Under that
 * caller, `layers` and every config in it hold their identity across an edit, so an
 * identity-keyed effect never re-runs: the resolver is never asked for the new
 * column, `getShapeFillColorEntry` / `getLabelFillColorEntry` correctly keep serving
 * the last-good rows (#119), and the layer paints the PREVIOUS column's colours for
 * good. The identity discipline the render path needs and the change detection the
 * load path needs are different jobs; this key does the second one by value.
 *
 * Cheap on purpose. It is recomputed every render — that is the whole point, since
 * a mutation is invisible to any memo — so it holds scalars and short id lists only.
 * Nothing here may serialise a payload that scales with the data: a categorical
 * palette, a colour map, a feature catalog. Those affect how a resource is DRAWN,
 * not whether it must be loaded, and the projections already handle them by value.
 *
 * INVARIANT: every config field that a resolver's `plan()` reads must appear here.
 * The lines below mirror, one for one, what each `plan()` looks at today —
 * `ShapesResolver` and `LabelsResolver` (tooltip fields, fill-colour column),
 * `PointsResolver` (memory cap, feature selection, colour-by), and `ImagesResolver`
 * (nothing: it plans its loader off element identity alone, which `elementMap`
 * already covers). A resolver that starts planning off a new field must add it here
 * in the same change, or that field gets exactly the bug described above.
 */

import type { LayerConfig } from './types';

/** Field separator. Neither a layer id, element key nor column name may contain it. */
const FIELD = '\u0001';
/** Item separator, for the short id lists (tooltip fields, feature selections). */
const ITEM = '\u0000';

function joinIds(ids: readonly (string | number)[] | undefined): string {
  return ids && ids.length > 0 ? ids.join(ITEM) : '';
}

/**
 * Serialise the load-relevant inputs of the visible layers, in render order.
 *
 * Invisible layers are omitted rather than encoded, matching the reconcile effect:
 * hiding a layer withdraws its resolve context, which is itself a change of key.
 */
export function describeResolveInputs(
  layers: Record<string, LayerConfig>,
  layerOrder: readonly string[]
): string {
  const parts: string[] = [];
  for (const layerId of layerOrder) {
    const config = layers[layerId];
    if (!config?.visible) continue;
    parts.push(layerId, config.type, config.elementKey);
    switch (config.type) {
      case 'shapes':
      case 'labels':
        parts.push(joinIds(config.tooltipFields), config.fillColorByColumn?.columnName ?? '');
        break;
      case 'points':
        parts.push(
          String(config.pointsMemoryCap ?? ''),
          // Both selection forms: names are the durable one and take precedence, but
          // codes still drive a config written before names existed.
          joinIds(config.featureNames),
          joinIds(config.featureCodes),
          String(config.colorByFeature ?? '')
        );
        break;
      case 'image':
        // `ImagesResolver.plan` reads no config — only whether the loader is idle.
        break;
    }
  }
  return parts.join(FIELD);
}
