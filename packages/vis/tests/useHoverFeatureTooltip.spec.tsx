import { act, renderHook } from '@testing-library/react';
import type { DeckGLRef, PickingInfo } from 'deck.gl';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SpatialFeatureTooltipData } from '../src/SpatialCanvas/SpatialFeatureTooltip.js';
import { useHoverFeatureTooltip } from '../src/SpatialCanvas/useHoverFeatureTooltip.js';

/**
 * The hover-tooltip machinery shared by both SpatialCanvas surfaces
 * (`SpatialCanvasViewer` and the full-UI `SpatialCanvasInner`). The pick→tooltip
 * resolution itself lives in `resolveHoverFeatureTooltip` (covered by
 * featureTooltipHover.spec); this guards the hook's own wiring: resolve → state →
 * portal, and the `enabled` / `renderTooltip === false` / `clearTooltip` gates.
 */

const TOOLTIP: SpatialFeatureTooltipData = {
  title: 'cell-1',
  items: [{ label: 'feature_id', value: 'cell-1' }],
};

const deckRef = createRef<DeckGLRef>();

/** A picked, single-layer hover (aggregate off ⇒ no Deck instance needed). */
const PICK = {
  picked: true,
  x: 10,
  y: 20,
  index: 0,
  object: {},
  layer: { id: 'shapes-1' },
} as unknown as PickingInfo;

function baseOptions(getFeatureTooltip = vi.fn(() => TOOLTIP)) {
  return {
    enabled: true,
    aggregate: false,
    getFeatureTooltip,
    hoverPickLayerIds: ['shapes-1'],
    deckRef,
    tooltipContainer: null,
  };
}

describe('useHoverFeatureTooltip', () => {
  it('resolves a pick into a portaled tooltip, then clears it', () => {
    const getFeatureTooltip = vi.fn(() => TOOLTIP);
    const { result } = renderHook(() => useHoverFeatureTooltip(baseOptions(getFeatureTooltip)));

    // Nothing shown before any hover.
    expect(result.current.tooltipPortal).toBeNull();

    // A container is needed to map deck-local coords to viewport coords.
    result.current.containerRef.current = document.createElement('div');

    act(() => result.current.resolveTooltip(PICK));
    expect(getFeatureTooltip).toHaveBeenCalledWith('shapes-1', { index: 0, object: {} });
    expect(result.current.tooltipPortal).not.toBeNull();

    act(() => result.current.clearTooltip());
    expect(result.current.tooltipPortal).toBeNull();
  });

  it('does no tooltip work when disabled (mode "off")', () => {
    const getFeatureTooltip = vi.fn(() => TOOLTIP);
    const { result } = renderHook(() =>
      useHoverFeatureTooltip({ ...baseOptions(getFeatureTooltip), enabled: false })
    );
    result.current.containerRef.current = document.createElement('div');

    act(() => result.current.resolveTooltip(PICK));
    expect(getFeatureTooltip).not.toHaveBeenCalled();
    expect(result.current.tooltipPortal).toBeNull();
  });

  it('suppresses the built-in tooltip when renderTooltip is false', () => {
    const getFeatureTooltip = vi.fn(() => TOOLTIP);
    const { result } = renderHook(() =>
      useHoverFeatureTooltip({ ...baseOptions(getFeatureTooltip), renderTooltip: false })
    );
    result.current.containerRef.current = document.createElement('div');

    act(() => result.current.resolveTooltip(PICK));
    // renderTooltip === false means the consumer draws its own tooltip: the hook
    // neither resolves nor portals one.
    expect(getFeatureTooltip).not.toHaveBeenCalled();
    expect(result.current.tooltipPortal).toBeNull();
  });

  it('drops a resolved tooltip when disabled, so re-enabling does not resurrect it', () => {
    const getFeatureTooltip = vi.fn(() => TOOLTIP);
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useHoverFeatureTooltip({ ...baseOptions(getFeatureTooltip), enabled }),
      { initialProps: { enabled: true } }
    );
    result.current.containerRef.current = document.createElement('div');

    act(() => result.current.resolveTooltip(PICK));
    expect(result.current.tooltipPortal).not.toBeNull();

    // Mode switched to 'off' — the stored result must be dropped, not just hidden.
    rerender({ enabled: false });
    expect(result.current.tooltipPortal).toBeNull();

    // Back on WITHOUT a fresh hover: nothing should reappear at the stale position.
    rerender({ enabled: true });
    expect(result.current.tooltipPortal).toBeNull();
  });

  it('shows nothing for an unpicked hover', () => {
    const getFeatureTooltip = vi.fn(() => TOOLTIP);
    const { result } = renderHook(() => useHoverFeatureTooltip(baseOptions(getFeatureTooltip)));
    result.current.containerRef.current = document.createElement('div');

    act(() =>
      result.current.resolveTooltip({ picked: false, x: 1, y: 2 } as unknown as PickingInfo)
    );
    expect(result.current.tooltipPortal).toBeNull();
  });
});
