import { applyRenderCapToColumnar } from '@spatialdata/core';
import type { Layer, LayersList } from 'deck.gl';
import type { PointsLayer } from './PointsLayer.js';
import type { PointsRenderStrategy } from './pointsRenderStrategies.js';
import { featureFilterAwaitingRowCodes, filterBatchSignature } from './pointsFeatureCodes.js';
import {
  DEFAULT_POINT_SIZE,
  renderColumnarScatterLayer,
} from './pointsScatterLayer.js';
import type { ColumnarNdarrayPointsBatch } from './pointsLoader.js';

function resolveScatterBatch(layer: PointsLayer): ColumnarNdarrayPointsBatch | undefined {
  const { featureCodes, preloadedFeatureCodes, renderCap } = layer.props;
  const state = layer.state as {
    preloadedBatch?: ColumnarNdarrayPointsBatch;
    filteredBatch?: ColumnarNdarrayPointsBatch;
    filteredBatchSignature?: string;
  };
  const signature = filterBatchSignature(featureCodes, preloadedFeatureCodes, renderCap);
  const cappedPreloaded = (): ColumnarNdarrayPointsBatch | undefined => {
    if (!state.preloadedBatch) {
      return undefined;
    }
    // Attach the row-aligned codes so this transient (pre-first-filter) fallback
    // colours by feature too; applyRenderCapToColumnar truncates them in lockstep.
    const withCodes =
      preloadedFeatureCodes && preloadedFeatureCodes.length > 0
        ? { ...state.preloadedBatch, featureCodes: preloadedFeatureCodes }
        : state.preloadedBatch;
    return applyRenderCapToColumnar(withCodes, renderCap);
  };

  // Row codes not loaded yet: we cannot filter, so draw the full batch. This is
  // only reachable on first load before the codes arrive (documented behavior).
  if (featureFilterAwaitingRowCodes(featureCodes, preloadedFeatureCodes)) {
    return cappedPreloaded();
  }

  // Up-to-date filtered batch for the current selection.
  if (state.filteredBatch && state.filteredBatchSignature === signature) {
    return state.filteredBatch;
  }

  // The selection changed and the new filtered batch is still computing off-thread.
  // Keep showing the PREVIOUS filtered result rather than flashing the full
  // unfiltered batch — but only when that previous result was itself a real
  // selection, not the unfiltered "all features" batch (whose signature matches
  // `featureCodes === undefined`). Reusing the unfiltered batch here is exactly
  // the flash-of-all-points the filter is meant to avoid.
  const unfilteredSignature = filterBatchSignature(undefined, preloadedFeatureCodes, renderCap);
  if (state.filteredBatch && state.filteredBatchSignature !== unfilteredSignature) {
    return state.filteredBatch;
  }

  // No reusable filtered batch. Draw the full batch only when nothing is selected;
  // while a selection's first filter is pending, draw nothing (a brief blank beats
  // a misleading flash of every feature).
  if (featureCodes === undefined) {
    return cappedPreloaded();
  }
  return undefined;
}

export const preloadedScatterStrategy: PointsRenderStrategy = {
  renderLayers(layer): Layer | null | LayersList {
    const {
      resource,
      opacity = 1,
      visible = true,
      pointSize = DEFAULT_POINT_SIZE,
      pointRadiusMinPixels,
      pointRadiusMaxPixels,
      pointMinSizeScale,
      viewZoom,
      color = [255, 100, 100, 200],
      use3d,
    } = layer.props;

    if (!visible) {
      return null;
    }

    const batch = resolveScatterBatch(layer);
    if (!batch) {
      return null;
    }

    // Namespace the sublayer id via the composite's sublayer-props helper.
    // Passing layer.props.id raw makes the ScatterplotLayer collide with its
    // parent PointsLayer id (deck asserts on every frame). The morton strategy
    // already derives `${id}-scatter`; do the same here.
    return renderColumnarScatterLayer(`${layer.props.id}-scatter`, batch, {
      color,
      pointSize,
      pointRadiusMinPixels,
      pointRadiusMaxPixels,
      pointMinSizeScale,
      viewZoom,
      opacity,
      modelMatrix: layer.props.modelMatrix,
      use3d,
    });
  },
};
