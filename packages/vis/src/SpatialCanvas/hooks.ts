/**
 * Hooks for SpatialCanvas functionality
 */

import { useState, useCallback } from 'react';
import type { ViewState } from './types';

/**
 * Hook for creating shareable view state between multiple SpatialCanvas instances.
 * 
 * This provides a simple way to link pan/zoom across multiple viewers.
 * 
 * @example Linked canvases
 * ```tsx
 * function LinkedViewers() {
 *   const [viewState, setViewState] = useSpatialViewState();
 *   
 *   return (
 *     <div style={{ display: 'flex', gap: '8px' }}>
 *       <SpatialCanvas 
 *         viewState={viewState} 
 *         onViewStateChange={setViewState} 
 *       />
 *       <SpatialCanvas 
 *         viewState={viewState} 
 *         onViewStateChange={setViewState} 
 *       />
 *     </div>
 *   );
 * }
 * ```
 * 
 * @example With initial state
 * ```tsx
 * const [viewState, setViewState] = useSpatialViewState({
 *   target: [1000, 1000],
 *   zoom: 2,
 * });
 * ```
 */
export function useSpatialViewState(
  initialState?: ViewState | null
): [ViewState | null, (vs: ViewState | null) => void] {
  const [viewState, setViewState] = useState<ViewState | null>(initialState ?? null);
  return [viewState, setViewState];
}

/**
 * Simple hook for syncing view state to URL parameters.
 * Useful for shareable links.
 */
export function useViewStateUrl(): {
  getViewStateFromUrl: () => ViewState | null;
  setViewStateToUrl: (vs: ViewState) => void;
} {
  const getViewStateFromUrl = useCallback((): ViewState | null => {
    if (typeof window === 'undefined') return null;
    
    const params = new URLSearchParams(window.location.search);
    const target = params.get('target');
    const zoom = params.get('zoom');
    
    if (!target || !zoom) return null;
    
    try {
      const parsedTarget = JSON.parse(target);
      const parsedZoom = Number.parseFloat(zoom);
      
      if (Array.isArray(parsedTarget) && !Number.isNaN(parsedZoom)) {
        return {
          target: parsedTarget as [number, number],
          zoom: parsedZoom,
        };
      }
    } catch {
      // Invalid URL params
    }
    
    return null;
  }, []);

  const setViewStateToUrl = useCallback((vs: ViewState) => {
    if (typeof window === 'undefined') return;
    
    const params = new URLSearchParams(window.location.search);
    params.set('target', JSON.stringify(vs.target));
    params.set('zoom', vs.zoom.toString());
    
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, '', newUrl);
  }, []);

  return { getViewStateFromUrl, setViewStateToUrl };
}
