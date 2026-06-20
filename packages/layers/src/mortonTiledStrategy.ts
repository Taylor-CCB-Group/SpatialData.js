import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { PolygonLayer, TileLayer } from 'deck.gl';
import type { Layer, LayersList } from 'deck.gl';
import type { PointsLayer } from './PointsLayer.js';
import {
  boundsFromTileBbox,
  intersectBounds,
  isPointTileBbox,
  scatterBoundsFromTileBbox,
  tileHandleFromDeckTile,
} from './pointsBbox.js';
import type { ColumnarNdarrayPointsBatch } from './pointsLoader.js';
import {
  DEFAULT_POINT_RADIUS_MAX_PIXELS,
  DEFAULT_POINT_RADIUS_MIN_PIXELS,
  DEFAULT_POINT_SIZE,
  renderColumnarScatterLayer,
} from './pointsScatterLayer.js';
import type { PointsRenderStrategy } from './pointsRenderStrategies.js';
import { featureCodesSignature } from './pointsFeatureCodes.js';
import { createTiledPointsDebugHooks } from './pointsTiledDebugHooks.js';
import {
  POINTS_TILE_DEBUG_PICK_KIND,
  pointsTileDebugPolygonData,
  tileDebugStatusFillColor,
  tileDebugStatusLineColor,
} from './pointsTileDebug.js';

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isColumnarBatch(value: unknown): value is ColumnarNdarrayPointsBatch {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as ColumnarNdarrayPointsBatch).format === 'columnar-ndarray'
  );
}

function renderedPointCount(batch: ColumnarNdarrayPointsBatch): number {
  if (batch.pointCount !== undefined) {
    return batch.pointCount;
  }
  if (batch.shape.length >= 2 && Number.isFinite(batch.shape[1])) {
    return batch.shape[1];
  }
  return batch.data[0]?.length ?? 0;
}

export const mortonTiledStrategy: PointsRenderStrategy = {
  renderLayers(layer: PointsLayer): Layer | null | LayersList {
    const {
      resource,
      featureCodes,
      showTileDebugOverlay,
      tileLoadCallbacks,
      opacity = 1,
      visible = true,
      pointSize = DEFAULT_POINT_SIZE,
      pointRadiusMinPixels,
      pointRadiusMaxPixels,
      color = [255, 100, 100, 200],
      use3d,
    } = layer.props;

    const localBounds = resource.loader.capabilities.bounds;
    if (!localBounds) {
      return null;
    }

    const debugHooks = createTiledPointsDebugHooks(layer.props.tileDebugStore, tileLoadCallbacks);
    const scatterStyleProps = {
      color,
      pointSize,
      pointRadiusMinPixels,
      pointRadiusMaxPixels,
      opacity,
      modelMatrix: layer.props.modelMatrix,
      use3d,
    };

    const layers: LayersList = [
      new TileLayer(
        layer.subLayerProps({
          id: 'tiles',
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          modelMatrix: layer.props.modelMatrix,
          extent: [localBounds.minX, localBounds.minY, localBounds.maxX, localBounds.maxY],
          opacity,
          visible,
          tileSize: 512,
          minZoom: -1,
          maxZoom: -1,
          refinementStrategy: 'best-available',
          updateTriggers: {
            getTileData: [resource.element.key, featureCodesSignature(featureCodes)],
            renderSubLayers: [
              pointSize,
              pointRadiusMinPixels,
              pointRadiusMaxPixels,
              color,
              opacity,
              layer.props.modelMatrix,
              use3d,
            ],
          },
          onViewportLoad(tiles: Array<{ index?: { x: number; y: number; z: number }; id?: string; bbox?: unknown }> | null) {
            const handles = (tiles ?? [])
              .map((tile: { index?: { x: number; y: number; z: number }; id?: string; bbox?: unknown }) =>
                tileHandleFromDeckTile(tile)
              )
              .filter(
                (handle): handle is NonNullable<ReturnType<typeof tileHandleFromDeckTile>> =>
                  handle != null
              );
            debugHooks.onViewportTilesRequested(handles);
          },
          async getTileData(tileProps: { index?: { x: number; y: number; z: number }; id?: string; bbox?: unknown; signal?: AbortSignal }) {
            const tile = tileHandleFromDeckTile(tileProps);
            if (!tile || !isPointTileBbox(tileProps.bbox)) {
              return null;
            }
            debugHooks.onTileLoadStart(tile);
            const rawBounds = boundsFromTileBbox(tile.bbox);
            const bounds = intersectBounds(rawBounds, localBounds);
            if (!bounds) {
              debugHooks.onTileLoadEnd(
                tile,
                { success: true, clippedBounds: null, pointCount: 0, loadMode: 'clipped' },
                rawBounds
              );
              return null;
            }
            try {
              const batch = await resource.loader.loadInBounds({
                bounds,
                featureCodes,
                signal: tileProps.signal,
              });
              if (!batch || !isColumnarBatch(batch)) {
                debugHooks.onTileLoadEnd(
                  tile,
                  { success: true, clippedBounds: bounds, pointCount: 0 },
                  rawBounds
                );
                return null;
              }
              debugHooks.onTileLoadEnd(
                tile,
                {
                  success: true,
                  clippedBounds: bounds,
                  pointCount: renderedPointCount(batch),
                  loadMode: batch.loadMode,
                },
                rawBounds
              );
              return batch;
            } catch (error) {
              const aborted = Boolean(tileProps.signal?.aborted) || isAbortError(error);
              debugHooks.onTileLoadEnd(
                tile,
                {
                  success: false,
                  aborted,
                  clippedBounds: bounds,
                  errorMessage: aborted ? 'aborted' : String(error),
                },
                rawBounds
              );
              if (aborted) {
                return null;
              }
              throw error;
            }
          },
          renderSubLayers: (props: {
            id: string;
            data?: ColumnarNdarrayPointsBatch | null;
            tile?: { bbox?: unknown };
          }) => {
            if (!props.data || !isColumnarBatch(props.data)) {
              return null;
            }
            const tileBbox = isPointTileBbox(props.tile?.bbox) ? props.tile.bbox : null;
            return renderColumnarScatterLayer(`${props.id}-scatter`, props.data, {
              ...scatterStyleProps,
              tileBounds: tileBbox ? scatterBoundsFromTileBbox(tileBbox) : undefined,
              tileSubLayer: true,
            });
          },
        })
      ),
    ];

    if (showTileDebugOverlay) {
      const entries = debugHooks.getTileDebugEntries();
      const debugSignature = layer.props.tileDebugSignature ?? debugHooks.getTileDebugSignature();
      const polygonData = pointsTileDebugPolygonData(entries).map(({ polygon, entry }) => ({
        polygon,
        entry,
        kind: POINTS_TILE_DEBUG_PICK_KIND as typeof POINTS_TILE_DEBUG_PICK_KIND,
      }));
      layers.push(
        new PolygonLayer(
          layer.subLayerProps({
            id: 'tile-debug',
            coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
            modelMatrix: layer.props.modelMatrix,
            data: polygonData,
            pickable: true,
            autoHighlight: true,
            highlightColor: [255, 255, 255, 120],
            getPolygon: (d: { polygon: [number, number][] }) => d.polygon,
            getFillColor: (d: { entry: { status: import('./pointsTileDebug.js').PointsTileStatus } }) =>
              tileDebugStatusFillColor(d.entry.status),
            getLineColor: (d: { entry: { status: import('./pointsTileDebug.js').PointsTileStatus } }) =>
              tileDebugStatusLineColor(d.entry.status),
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
            filled: true,
            stroked: true,
            opacity: Math.min(1, opacity + 0.15),
            visible,
            updateTriggers: {
              data: [debugSignature],
              getFillColor: [debugSignature],
              getLineColor: [debugSignature],
              getPolygon: [debugSignature],
            },
          })
        )
      );
    }

    return layers;
  },
};
