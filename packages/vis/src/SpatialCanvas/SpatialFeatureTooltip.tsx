import type {
  SpatialFeatureTooltipData,
  SpatialFeatureTooltipItem,
  SpatialFeatureTooltipSection,
} from '@spatialdata/core';
import { formatSpatialElementLabel } from '@spatialdata/core';
import type { CSSProperties } from 'react';

export type {
  SpatialFeatureTooltipData,
  SpatialFeatureTooltipItem,
  SpatialFeatureTooltipSection,
} from '@spatialdata/core';

export type SpatialCanvasTooltipRenderProps = {
  clientX: number;
  clientY: number;
  tooltip: SpatialFeatureTooltipData;
};

const tooltipBaseStyle: CSSProperties = {
  maxWidth: 300,
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

const sectionHeaderStyle: CSSProperties = {
  marginBottom: 4,
  fontWeight: 600,
  fontSize: 11,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  color: '#94a3b8',
};

const sectionWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const sectionDividerStyle: CSSProperties = {
  margin: '8px 0',
  borderTop: '1px solid rgba(255,255,255,0.12)',
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

function elementHeaderLabel(section: SpatialFeatureTooltipSection): string {
  return formatSpatialElementLabel(section.elementType, section.elementKey);
}

function TooltipItems({ items }: { items: SpatialFeatureTooltipItem[] }) {
  return (
    <div style={itemsWrapStyle}>
      {items.map((item) => (
        <div key={`${item.label}:${item.value}`} style={itemRowStyle}>
          <span style={itemLabelStyle}>{item.label}</span>
          <span style={itemValueStyle}>{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function TooltipSectionBlock({
  section,
  showElementHeader,
}: {
  section: SpatialFeatureTooltipSection;
  showElementHeader: boolean;
}) {
  return (
    <div style={sectionWrapStyle}>
      {showElementHeader && <div style={sectionHeaderStyle}>{elementHeaderLabel(section)}</div>}
      {section.title && <div style={titleStyle}>{section.title}</div>}
      <TooltipItems items={section.items} />
    </div>
  );
}

export interface SpatialFeatureTooltipProps {
  /** Viewport X of the picked feature (deck.gl `info.x` + viewer origin). */
  x: number;
  /** Viewport Y of the picked feature (deck.gl `info.y` + viewer origin). */
  y: number;
  tooltip: SpatialFeatureTooltipData;
  /**
   * `fixed` — viewport coordinates (use with a portal). Default.
   * `absolute` — coordinates relative to the offset parent.
   */
  position?: 'absolute' | 'fixed';
  /** Stacking order when `position` is `fixed` (above SpatialCanvas fullscreen overlay). */
  zIndex?: number;
}

export function SpatialFeatureTooltip({
  x,
  y,
  tooltip,
  position = 'fixed',
  zIndex = 10001,
}: SpatialFeatureTooltipProps) {
  const tooltipStyle: CSSProperties = {
    ...tooltipBaseStyle,
    position,
    left: x + TOOLTIP_OFFSET,
    top: y + TOOLTIP_OFFSET,
    ...(position === 'fixed' ? { zIndex } : {}),
  };

  const sections = tooltip.sections;
  if (sections && sections.length > 0) {
    return (
      <div style={tooltipStyle}>
        {sections.map((section, index) => (
          <div key={section.layerId ?? `${section.elementType}:${section.elementKey}`}>
            {index > 0 && <div style={sectionDividerStyle} />}
            <TooltipSectionBlock section={section} showElementHeader />
          </div>
        ))}
      </div>
    );
  }

  const showElementHeader = !!(tooltip.elementKey && tooltip.elementType);
  const singleSection: SpatialFeatureTooltipSection = {
    elementKey: tooltip.elementKey ?? '',
    elementType: tooltip.elementType ?? '',
    layerId: tooltip.layerId,
    title: tooltip.title,
    items: tooltip.items,
  };

  return (
    <div style={tooltipStyle}>
      <TooltipSectionBlock section={singleSection} showElementHeader={showElementHeader} />
    </div>
  );
}
