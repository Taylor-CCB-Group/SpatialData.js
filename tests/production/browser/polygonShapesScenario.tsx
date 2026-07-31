import { Deck, OrthographicView } from '@deck.gl/core';
import { createShapesDeckLayer } from '@spatialdata/layers';
import { useEffect, useRef, useState } from 'react';

const fixtureMetadataUrl = new URL(
  '/test-fixtures/v0.7.2/blobs.zarr/shapes/blobs_polygons/zarr.json',
  window.location.href
).href;

declare global {
  interface Window {
    polygonShapesDeckErrors: string[];
    polygonShapesRenderFrames: number;
  }
}

window.polygonShapesDeckErrors = [];
window.polygonShapesRenderFrames = 0;

export function PolygonFixtureConsumer() {
  const container = useRef<HTMLDivElement>(null);
  const [fixtureReady, setFixtureReady] = useState(false);
  const [fixtureError, setFixtureError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(fixtureMetadataUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`Fixture metadata request failed: ${response.status}`);
        return response.json();
      })
      .then((metadata: { attributes?: { 'encoding-type'?: string } }) => {
        if (metadata.attributes?.['encoding-type'] !== 'ngff:shapes') {
          throw new Error('Canonical fixture did not contain an ngff:shapes element');
        }
        if (active) setFixtureReady(true);
      })
      .catch((error: unknown) => {
        if (active) setFixtureError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!fixtureReady || !container.current) return;

    // Triangle from the first polygon in the canonical blobs_polygons GeoParquet
    // fixture. It is intentionally handed to the published vertex-pulling layer,
    // not a circle or a Deck built-in polygon layer.
    const layer = createShapesDeckLayer(
      {
        kind: 'flat-polygons',
        geometryKind: 'polygon',
        elementKey: 'blobs_polygons',
        featureIds: ['blob-0'],
        polygonBinary: {
          positions: new Float32Array([
            340.19708, 258.2137, 316.17697, 197.0654, 291.0622, 205.28772,
          ]),
          startIndices: new Int32Array([0, 3]),
        },
        rowIndexByFeatureIndex: new Int32Array([0]),
      },
      { kind: 'shapes', elementKey: 'blobs_polygons', visible: true },
      { id: 'shapes:blobs_polygons', pickingEnabled: false }
    );
    const deck = new Deck({
      parent: container.current,
      views: new OrthographicView({ id: 'fixture' }),
      initialViewState: { target: [315, 225, 0], zoom: 2 },
      controller: false,
      layers: layer ? [layer] : [],
      onAfterRender: () => {
        window.polygonShapesRenderFrames += 1;
      },
      onError: (error) => {
        window.polygonShapesDeckErrors.push(error.message);
        console.error(`FlatPolygon deck error: ${error.message}`);
      },
    });
    return () => deck.finalize();
  }, [fixtureReady]);

  if (fixtureError) return <output data-testid="fixture-error">{fixtureError}</output>;
  if (!fixtureReady)
    return <output data-testid="fixture-loading">Loading canonical polygon fixture...</output>;
  return <div ref={container} data-testid="fixture-ready" style={{ width: 800, height: 600 }} />;
}
