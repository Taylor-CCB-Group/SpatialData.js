/**
 * Two shapes layers over ONE element, each colouring by its own table column.
 *
 * `blobs.zarr` has no table annotating its shapes, so the circles get a synthetic
 * one: column `a` is all "red", column `b` all "green". Layer A hides the odd
 * circles and colours by `a`; layer B hides the even ones and colours by `b`. The
 * two layers cover disjoint circles, so the picture says which column each drew:
 *
 *  - correct: even circles red, odd circles green, and it stays that way;
 *  - the old bug (fill rows cached per element, not per element and column): the
 *    two layers evict each other's rows, every circle is the same colour, and the
 *    colour can flip as loads settle. `fetches` keeps climbing instead of stopping.
 */

import type { SpatialData } from '@spatialdata/core';
import { SpatialDataProvider, useSpatialData } from '@spatialdata/react';
import { useMemo, useState } from 'react';
import { type RenderStack, SpatialCanvasViewer, type ViewState } from '../../src/index';
import { getLocalBlobsFixtureUrl } from './fixtureUrls';

const ELEMENT = 'blobs_circles';
const COORDINATE_SYSTEM = 'global';
const RED: [number, number, number] = [255, 40, 40];
const GREEN: [number, number, number] = [40, 220, 40];

const entry = (
  id: string,
  column: 'a' | 'b',
  hiddenFeatureIds: string[],
  palette: Record<string, [number, number, number]>
): RenderStack['entries'][number] => ({
  kind: 'spatial',
  id,
  visible: true,
  source: { elementType: 'shapes', elementKey: ELEMENT, coordinateSystem: COORDINATE_SYSTEM },
  props: {
    opacity: 1,
    strokeColor: [255, 255, 255, 220],
    strokeWidth: 1,
    fillColorByColumn: {
      columnName: column,
      mode: 'categorical',
      categoricalPalette: { byValue: palette },
    },
    featureState: { hiddenFeatureIds },
  },
});

const STACK: RenderStack = {
  schemaVersion: 1,
  entries: [
    entry('layer-a', 'a', ['1', '3'], { red: RED }),
    entry('layer-b', 'b', ['0', '2', '4'], { green: GREEN }),
  ],
};

/** A table over the circles, counting how often its columns are read. */
function withShapesTable(base: SpatialData, onFetch: (names: string[]) => void): SpatialData {
  const table = {
    getTableKeys: () => ({
      region: [ELEMENT],
      regionKey: 'region',
      instanceKey: 'instance_id',
    }),
    loadObsIndex: async () => ['0', '1', '2', '3', '4'],
    loadObsColumns: async (names: string[]) => {
      if (names.includes('a') || names.includes('b')) onFetch(names);
      return names.map((name) => {
        if (name === 'region') return Array(5).fill(ELEMENT);
        return Array(5).fill(name === 'a' ? 'red' : 'green');
      });
    },
    getObsColumnKinds: (names: string[]) => names.map(() => 'categorical' as const),
  };
  const wrapped = Object.create(base);
  // The geometry load joins shapes to the real store's tables, and it has none for
  // these. Pair each circle with its row here instead.
  const circles = base.shapes?.[ELEMENT];
  if (circles) {
    const joined = Object.create(circles);
    joined.loadRenderData = async () => ({
      ...(await circles.loadRenderData()),
      rowIndexByFeatureIndex: Int32Array.from([0, 1, 2, 3, 4]),
    });
    wrapped.shapes = { ...base.shapes, [ELEMENT]: joined };
  }
  wrapped.getAssociatedTables = (kind: string, key: string) =>
    kind === 'shapes' && key === ELEMENT
      ? [['shapes_table', table]]
      : base.getAssociatedTables(kind, key);
  wrapped.getAssociatedTable = (kind: string, key: string) =>
    wrapped.getAssociatedTables(kind, key)[0];
  return wrapped;
}

function Viewer({ onFetch }: { onFetch: (names: string[]) => void }) {
  const { spatialData, loading, error } = useSpatialData();
  const [viewState, setViewState] = useState<ViewState | null>(null);
  const patched = useMemo(
    () => (spatialData ? withShapesTable(spatialData, onFetch) : null),
    [spatialData, onFetch]
  );
  if (loading) return <div style={{ padding: 16, color: '#888' }}>Loading blobs fixture…</div>;
  if (error || !patched) {
    return <div style={{ padding: 16, color: '#a88' }}>{error?.message ?? 'No data.'}</div>;
  }
  return (
    <SpatialCanvasViewer
      spatialData={patched}
      coordinateSystem={COORDINATE_SYSTEM}
      renderStack={STACK}
      viewState={viewState}
      onViewStateChange={setViewState}
      renderTooltip={false}
      style={{ width: '100%', height: '100%' }}
    />
  );
}

export default function SharedElementDemo() {
  const fixtureUrl = useMemo(() => getLocalBlobsFixtureUrl(), []);
  const [fetches, setFetches] = useState(0);
  // Stable: the viewer's memo depends on it.
  const onFetch = useMemo(() => () => setFetches((n) => n + 1), []);
  return (
    <SpatialDataProvider source={fixtureUrl}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div
          style={{
            flexShrink: 0,
            padding: '10px 12px',
            borderBottom: '1px solid #333',
            background: '#1e1e1e',
            fontSize: 12,
          }}
        >
          Two shapes layers over <code>{ELEMENT}</code>: layer A (even circles) colours by{' '}
          <code>a</code> and should be <span style={{ color: `rgb(${RED})` }}>red</span>; layer B
          (odd circles) colours by <code>b</code> and should be{' '}
          <span style={{ color: `rgb(${GREEN})` }}>green</span>.
          <div style={{ color: '#888', marginTop: 4 }}>
            Column reads: <code data-testid="fetches">{fetches}</code> (two per column under
            StrictMode, then it stops; it keeps climbing if the layers evict each other)
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <Viewer onFetch={onFetch} />
        </div>
      </div>
    </SpatialDataProvider>
  );
}
