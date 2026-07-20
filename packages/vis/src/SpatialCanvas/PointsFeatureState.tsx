/**
 * Reactive points feature state for the properties panel.
 *
 * The `PointsDataEngine` is a mutable external store owned by `useLayerData`
 * (it drives the render path). Rather than prop-drill a bundle of getters that
 * read that mutable state, the panel subtree subscribes to the engine directly
 * through `usePointsFeatureState`.
 *
 * One hook, one subscription: `usePointsFeatureState` runs a single
 * `useSyncExternalStore` against the engine's monotonic `version` (a primitive
 * snapshot — the engine's object-returning readers allocate fresh each call and
 * would infinite-loop as a snapshot) and returns every derived read at once.
 *
 * The hook and its consumers carry `'use no memo'`. The reads take
 * otherwise-stable inputs (the engine + resolved target), so the React Compiler
 * would cache them as stable and never repaint — the escape hatch keeps the
 * engine-backed reads live. It is scoped to this small data hook and the two
 * leaf panels, far narrower than the old canvas-wide opt-out on SpatialCanvasInner.
 *
 * The context only carries stable handles (engine, resolved target, and bound
 * subscribe/snapshot callbacks); config flows via props. Headless (panel-less)
 * consumers read `pointsEngine` + `resolvePointsTarget` off the renderer-hook
 * result, wrap a subtree in this provider, and consume `usePointsFeatureState`.
 */
import type { PointsDataEngine, PointsLoadTarget } from '@spatialdata/layers';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';

interface PointsFeatureStateContextValue {
  engine: PointsDataEngine;
  /** The resolved engine target for this layer, or `undefined` when the layer
   * is not (yet) a resolvable points element. */
  target: PointsLoadTarget | undefined;
  /** Stable `useSyncExternalStore` subscribe (bound to the engine). */
  subscribe: (onChange: () => void) => () => void;
  /** Stable `useSyncExternalStore` snapshot: the engine's primitive version. */
  getVersion: () => number;
}

const PointsFeatureStateContext = createContext<PointsFeatureStateContextValue | null>(null);

export interface PointsFeatureStateProviderProps {
  engine: PointsDataEngine;
  target: PointsLoadTarget | undefined;
  children: ReactNode;
}

export function PointsFeatureStateProvider({
  engine,
  target: targetProp,
  children,
}: PointsFeatureStateProviderProps) {
  // The resolver allocates a fresh `{ key, layerId, element }` object every
  // render, so pin the target's identity to its underlying fields. Left
  // unpinned, the churn re-creates the request callback each render and re-fires
  // its effect, looping ensureFeatureCatalog → notify → render → … Depending on
  // the key/element fields (not `targetProp`) is the point — targetProp is a
  // fresh object each render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key+element ARE the identity
  const target = useMemo<PointsLoadTarget | undefined>(
    () =>
      targetProp
        ? { key: targetProp.key, layerId: targetProp.layerId, element: targetProp.element }
        : undefined,
    [targetProp?.key, targetProp?.layerId, targetProp?.element]
  );
  // The engine methods are plain (unbound `this`), so wrap them in callbacks
  // keyed on the engine. Stable identities keep useSyncExternalStore from
  // re-subscribing every render.
  const subscribe = useCallback((onChange: () => void) => engine.subscribe(onChange), [engine]);
  const getVersion = useCallback(() => engine.getVersion(), [engine]);
  const value = useMemo<PointsFeatureStateContextValue>(
    () => ({ engine, target, subscribe, getVersion }),
    [engine, target, subscribe, getVersion]
  );
  return (
    <PointsFeatureStateContext.Provider value={value}>
      {children}
    </PointsFeatureStateContext.Provider>
  );
}

function usePointsFeatureContext(): PointsFeatureStateContextValue {
  const value = useContext(PointsFeatureStateContext);
  if (!value) {
    throw new Error('usePointsFeatureState must be used within a <PointsFeatureStateProvider>.');
  }
  return value;
}

export interface PointsFeatureState {
  /** The feature catalog: `undefined` until requested/settled, `null` when the
   * element has no `feature_key`, else the catalog. */
  catalog: ReturnType<PointsDataEngine['getFeatureCatalog']>;
  /** Whether the feature catalog is currently being built. */
  catalogLoading: boolean;
  /** Whether the full-dataset catalog scan is still refining an instant preview. */
  catalogRefining: boolean;
  /** Distinct feature codes present in the resident batch, or `undefined` until
   * the row codes are resident. */
  residentCodes: ReturnType<PointsDataEngine['getResidentFeatureCodes']>;
  /** Feature codes of the last-completed matched selection (non-resident
   * features currently on screen), used to grey rows by what's rendered. */
  loadedMatchingCodes: ReturnType<PointsDataEngine['getLoadedMatchingFeatureCodes']>;
  /** Whether a non-resident feature can be fetched on demand (feature-index scan). */
  supportsOnDemandLoad: boolean;
  /** Progressive load state of the feature-index scan for the selection passed
   * to the hook, or `undefined` when nothing is selected / it hasn't started. */
  matchingLoadState: ReturnType<PointsDataEngine['getMatchingLoadState']>;
  /** Truncation of what's on screen for the selection passed to the hook (so the
   * UI can show when raising the memory cap would load more). */
  truncation: ReturnType<PointsDataEngine['getActiveTruncation']>;
  /** Running per-feature counts over the resident window (`code → rows`), available
   * while the whole-dataset counts scan is still running. Partial by construction. */
  residentFeatureCounts: ReturnType<PointsDataEngine['getResidentFeatureCounts']>;
  /** Stable callback — trigger the full-dataset catalog build (idempotent). */
  requestCatalog: () => void;
  /** Stable callback — set (or clear, with null) the hover-highlighted feature code
   * for this layer, so its points are emphasised on the canvas. */
  setHighlightedFeature: (featureCode: number | null) => void;
}

const EMPTY_POINTS_FEATURE_STATE: Omit<
  PointsFeatureState,
  'requestCatalog' | 'setHighlightedFeature'
> = {
  catalog: undefined,
  catalogLoading: false,
  catalogRefining: false,
  residentCodes: undefined,
  loadedMatchingCodes: undefined,
  supportsOnDemandLoad: false,
  matchingLoadState: undefined,
  truncation: undefined,
  residentFeatureCounts: undefined,
};

/**
 * Reactive snapshot of the points feature state for the surrounding
 * `<PointsFeatureStateProvider>`. Subscribes the calling component to the engine
 * (re-renders on every `notify`) and returns all derived reads for `featureCodes`
 * (the active selection — pass `config.featureCodes`), plus a stable
 * `requestCatalog`.
 */
export function usePointsFeatureState(featureCodes?: readonly number[]): PointsFeatureState {
  'use no memo';
  const { engine, target, subscribe, getVersion } = usePointsFeatureContext();
  // Reactivity: re-render this component on every engine mutation. The returned
  // version is unused — the subscription is the point.
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const requestCatalog = useCallback(() => {
    if (target) void engine.ensureFeatureCatalog(target);
  }, [engine, target]);
  const setHighlightedFeature = useCallback(
    (featureCode: number | null) => {
      if (target) engine.setHighlightedFeature(target.key, featureCode);
    },
    [engine, target]
  );

  if (!target) {
    return { ...EMPTY_POINTS_FEATURE_STATE, requestCatalog, setHighlightedFeature };
  }
  const key = target.key;
  const scannable = engine.supportsFeatureScan(key);
  const hasSelection = !!featureCodes && featureCodes.length > 0;
  return {
    catalog: engine.getFeatureCatalog(key),
    catalogLoading: engine.isFeatureCatalogLoading(key),
    catalogRefining: engine.isFeatureCatalogRefining(key),
    residentCodes: engine.getResidentFeatureCodes(key),
    loadedMatchingCodes: engine.getLoadedMatchingFeatureCodes(key),
    supportsOnDemandLoad: scannable,
    // Only a whole-dataset scan reports a load state; before a catalog loads a
    // dict-only element can only filter the resident batch in memory (no scan).
    matchingLoadState:
      hasSelection && scannable ? engine.getMatchingLoadState(key, featureCodes) : undefined,
    truncation: engine.getActiveTruncation(key, featureCodes),
    residentFeatureCounts: engine.getResidentFeatureCounts(key),
    requestCatalog,
    setHighlightedFeature,
  };
}
