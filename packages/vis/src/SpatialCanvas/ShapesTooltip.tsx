import type { CSSProperties } from 'react';

type TooltipItem = {
  label: string;
  value: string;
};

type TooltipData = {
  title?: string;
  items: TooltipItem[];
};

const tooltipStyle: CSSProperties = {
  position: 'absolute',
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

export interface ShapesTooltipProps {
  x: number;
  y: number;
  tooltip: TooltipData;
}

export function ShapesTooltip({ x, y, tooltip }: ShapesTooltipProps) {
  return (
    <div
      style={{
        ...tooltipStyle,
        left: x + 12,
        top: y + 12,
      }}
    >
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
