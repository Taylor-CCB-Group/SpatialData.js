import { DEFAULT_POINTS_MEMORY_CAP } from "@spatialdata/core";
import { useSpatialCanvasRendererFromLayerInputs } from "./SpatialCanvasViewer";
import { PointsLayerConfig } from "./types";
import { useSpatialCanvasActions } from "./context";
import { PointsFeatureFilterPanel } from "./PointsFeatureFilterPanel";


// we don't really want to make this be tied to the whole bundle of things from here
// we could Pick<> things we want, may want a more substantial design change.
type RendererProps = ReturnType<typeof useSpatialCanvasRendererFromLayerInputs>;

export interface PointsLayerPanelProps {
  config: PointsLayerConfig;
  rendererProps: RendererProps;
}

function PointsMemoryCap({config}: PointsLayerPanelProps) {
  const actions = useSpatialCanvasActions();
  const currentCap = config.pointsMemoryCap ?? DEFAULT_POINTS_MEMORY_CAP;
  // Discrete options (one reload per choice, vs. a free number
  // input that would reload on every keystroke). Include the
  // current value so a saved config off the preset list still
  // shows correctly.
  const capOptions = Array.from(
    new Set([1, 2, 4, 8, 16].map((m) => m * 1_000_000).concat(currentCap))
  ).sort((a, b) => a - b);
  return (
    <label
      style={{
        color: '#ccc',
        fontSize: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      Memory cap
      <select
        value={currentCap}
        onChange={(e) =>
          actions.updateLayer(config.id, {
            pointsMemoryCap: Number(e.target.value),
          })
        }
        style={{
          color: '#ccc',
          fontSize: '12px',
          padding: '4px 6px',
          borderRadius: 4,
          border: '1px solid #444',
          background: '#1a1a1a',
        }}
      >
        {capOptions.map((cap) => (
          <option key={cap} value={cap}>
            {`${(cap / 1_000_000).toLocaleString(undefined, {
              maximumFractionDigits: 1,
            })}M rows`}
            {cap === DEFAULT_POINTS_MEMORY_CAP ? ' (default)' : ''}
          </option>
        ))}
      </select>
      <span style={{ color: '#888', fontSize: '11px' }}>
        Max rows kept in memory. Higher shows more points; picking is
        limited to ~16.7M/layer.
      </span>
    </label>
  )
}

function ShowMatchingPoints({config, rendererProps}: PointsLayerPanelProps) {
  const { id, featureCodes } = config;
  const {
    getPointsResidentTruncation
  } = rendererProps;
  const t = getPointsResidentTruncation(id, featureCodes);
  if (!t) return null;
  const noun = t.filtered ? 'matching points' : 'points';
  // t.loaded is not the number we're showing, this statement is almost always misleading.
  // at least after separating from bloated parent we get proper HMR.
  const message = t.truncated
    ? `Showing ${t.loaded.toLocaleString()}${t.total !== undefined ? ` of ${t.total.toLocaleString()}` : ''
    } ${noun} — capped; raise the cap for more.`
    : t.filtered
      ? `Loaded all ${t.loaded.toLocaleString()} ${noun}.`
      : `All ${t.loaded.toLocaleString()} ${noun} loaded (not capped).`;
  return (
    <span
      style={{
        color: t.truncated ? '#d0a24c' : '#888',
        fontSize: '11px',
      }}
    >
      {message}
    </span>
  );
}

export default function PointsLayerPanel(props: PointsLayerPanelProps) {
  const actions = useSpatialCanvasActions();
  const {config, rendererProps} = props;
  const selectedConfig = config;
  const {
    requestPointsFeatureCatalog,
    getPointsFeatureCatalog,
    isPointsFeatureCatalogLoading,
    isPointsFeatureCatalogRefining,
    getPointsResidentFeatureCodes,
    getPointsMatchingLoadState,
    getPointsLoadedMatchingFeatureCodes,
    getPointsSupportsOnDemandLoad,
  } = rendererProps;
  return (
    <>
    {/* spreading props like this may be bad, should have more focussed types to pass */}
      <PointsMemoryCap {...props} />
      <ShowMatchingPoints {...props} />
      {/* this version has a lot more noise and ceremony, though */}
      <PointsFeatureFilterPanel
        layerId={selectedConfig.id} //can't it just get this from the config?
        config={selectedConfig}
        catalog={getPointsFeatureCatalog(selectedConfig.id)}
        catalogLoading={isPointsFeatureCatalogLoading(selectedConfig.id)}
        catalogRefining={isPointsFeatureCatalogRefining(selectedConfig.id)}
        residentCodes={getPointsResidentFeatureCodes(selectedConfig.id)}
        loadedMatchingCodes={getPointsLoadedMatchingFeatureCodes(selectedConfig.id)}
        supportsOnDemandLoad={getPointsSupportsOnDemandLoad(selectedConfig.id)}
        matchingLoadState={getPointsMatchingLoadState(
          selectedConfig.id,
          selectedConfig.featureCodes
        )}
        onRequestCatalog={requestPointsFeatureCatalog}
        updateLayer={actions.updateLayer}
      />

    </>
  )
}