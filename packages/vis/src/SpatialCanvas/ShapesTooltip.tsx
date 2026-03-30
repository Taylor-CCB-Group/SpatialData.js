import type { CSSProperties } from 'react';

export type ShapesTooltipItem = {
  label: string;
  value: string;
};

/** Serializable payload for shape hover tooltips (library-owned contract). */
export type ShapesTooltipData = {
  title?: string;
  items: ShapesTooltipItem[];
};

/** Props for optional `renderTooltip` on SpatialCanvas (client = viewport coordinates). */
export type SpatialCanvasTooltipRenderProps = {
  clientX: number;
  clientY: number;
  tooltip: ShapesTooltipData;
};

const tooltipBaseStyle: CSSProperties = {
  maxWidth: 260,
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.1)',
  backgroundColor: 'rgba(10, 10, 10, 0.9)',
  padding: '8px 10px',
  fontSize: 12,
  color: '#f5f5f5',
  pointerEvents: 'none',
  boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
};

const titleStyle: CSSProperties = {
  marginBottom: 6,
  fontWeight: 600,
  color: '#fafafa',
};

const itemsWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const itemRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
};

const itemLabelStyle: CSSProperties = {
  minWidth: 72,
  color: '#cbd5e1',
};

const itemValueStyle: CSSProperties = {
  color: '#ffffff',
  overflowWrap: 'anywhere',
};

const TOOLTIP_OFFSET = 12;

export interface ShapesTooltipProps {
  /** Viewport X of the pick point (deck.gl `info.x` + viewer origin). */
  x: number;
  /** Viewport Y of the pick point (deck.gl `info.y` + viewer origin). */
  y: number;
  tooltip: ShapesTooltipData;
  /**
   * `fixed` — viewport coordinates (use with a portal). Default.
   * `absolute` — coordinates relative to the offset parent.
   */
  position?: 'absolute' | 'fixed';
  /** Stacking order when `position` is `fixed` (above SpatialCanvas fullscreen overlay). */
  zIndex?: number;
}

export function ShapesTooltip({
  x,
  y,
  tooltip,
  position = 'fixed',
  zIndex = 10001,
}: ShapesTooltipProps) {
  const tooltipStyle: CSSProperties = {
    ...tooltipBaseStyle,
    position,
    left: x + TOOLTIP_OFFSET,
    top: y + TOOLTIP_OFFSET,
    ...(position === 'fixed' ? { zIndex } : {}),
  };

  return (
    <div style={tooltipStyle}>
      {tooltip.title && (
        <div style={titleStyle}>
          {tooltip.title}
        </div>
      )}
      <div style={itemsWrapStyle}>
        {tooltip.items.map((item) => (
          <div key={item.label} style={itemRowStyle}>
            <span style={itemLabelStyle}>{item.label}</span>
            <span style={itemValueStyle}>{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
