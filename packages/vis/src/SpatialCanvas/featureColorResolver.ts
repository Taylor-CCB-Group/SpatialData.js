/**
 * The runtime seam for host-computed feature colours.
 *
 * A layer config can say "colour by this table column", and `featureState` can carry
 * a handful of per-feature overrides. Neither fits the case this exists for: a host
 * that is driving colour from data we do not have — a column it computed, an
 * annotation from outside the table, a live selection — for every feature in the
 * element.
 *
 * Expressing that as a `featureId → colour` dictionary makes the host stringify
 * integers it already had, and makes us copy the result into a Map and then into a
 * buffer. So the host hands us the buffer.
 *
 * This is deliberately NOT part of the Render Stack. `entry.props` is JSON that
 * survives being saved and reloaded; a `Uint8Array` in there would be a lie about
 * what a saved config is. It belongs with the other runtime attachments the viewer
 * already takes — `hostLayerResolver`, `vivImageExtensionResolver`,
 * `vivImagePropsResolver` — which is the same split points already uses: serialisable
 * config in the store, runtime render state on its own channel.
 */

import type { FeatureColorBuffer } from '@spatialdata/layers';

export type FeatureColorResolverContext = {
  layerId: string;
  elementKey: string;
  kind: 'shapes' | 'labels';
  /**
   * Shapes only: the feature ordering the returned buffer is indexed by.
   *
   * A shape's index is its position in the loaded geometry, which the loader
   * decides — so this is the only safe basis for building a shapes buffer. It is
   * absent for labels, whose index is the raster's own pixel value and needs no
   * ordering to be agreed.
   */
  featureIds?: readonly string[];
};

/**
 * Return precomputed RGBA for a layer, or `undefined` to fall back to the config.
 *
 * **Return a stable identity when nothing has changed.** This is consulted on every
 * render (a hover re-renders for the tooltip), and a fresh buffer each time means a
 * GPU upload each time. Mutate-and-replace when the colours genuinely change; return
 * the same object otherwise.
 *
 * Alpha is a modulation, not an opacity: `0` hides the feature, anything else scales
 * what the layer would otherwise draw at. Bake hide/fade into it — the buffer wins
 * over `featureState` rather than merging with it.
 */
export type FeatureColorResolver = (
  ctx: FeatureColorResolverContext
) => FeatureColorBuffer | undefined;

/**
 * Keep the wrapper identity stable while the bytes are unchanged.
 *
 * The contract above asks hosts to return a stable object, but the expensive thing
 * is the `colors` buffer, and a host that reuses the buffer while returning a fresh
 * `{ colors, count }` wrapper each render is an easy and invisible mistake — it
 * would re-upload a multi-megabyte texture every frame. Collapsing on the buffer's
 * identity makes that mistake free instead of catastrophic.
 */
export function createFeatureColorStabilizer(): (
  layerId: string,
  buffer: FeatureColorBuffer | undefined
) => FeatureColorBuffer | undefined {
  const byLayer = new Map<string, FeatureColorBuffer>();
  return (layerId, buffer) => {
    if (!buffer) {
      byLayer.delete(layerId);
      return undefined;
    }
    const cached = byLayer.get(layerId);
    if (cached && cached.colors === buffer.colors && cached.count === buffer.count) {
      return cached;
    }
    byLayer.set(layerId, buffer);
    return buffer;
  };
}
