import { describe, expect, it } from 'vitest';
import {
  attachTooltipElementContext,
  formatSpatialElementLabel,
  mergeSpatialFeatureTooltips,
} from '../src/tooltip.js';

describe('tooltip display helpers', () => {
  it('formats element labels as type/key', () => {
    expect(formatSpatialElementLabel('shapes', 'cells')).toBe('shapes/cells');
  });

  it('prepends element context to tooltip items', () => {
    expect(
      attachTooltipElementContext(
        { title: 'cell-1', items: [{ label: 'area_px', value: '42' }] },
        { elementKey: 'cells', elementType: 'shapes', layerId: 'shapes:cells' }
      )
    ).toEqual({
      title: 'cell-1',
      elementKey: 'cells',
      elementType: 'shapes',
      layerId: 'shapes:cells',
      items: [
        { label: 'element', value: 'shapes/cells' },
        { label: 'area_px', value: '42' },
      ],
    });
  });

  it('merges multiple tooltips into sections', () => {
    const merged = mergeSpatialFeatureTooltips([
      attachTooltipElementContext(
        { items: [{ label: 'a', value: '1' }] },
        { elementKey: 'shapes_a', elementType: 'shapes' }
      ),
      attachTooltipElementContext(
        { items: [{ label: 'b', value: '2' }] },
        { elementKey: 'labels_b', elementType: 'labels' }
      ),
    ]);

    expect(merged?.sections).toHaveLength(2);
    expect(merged?.sections?.[0].elementKey).toBe('shapes_a');
    expect(merged?.sections?.[1].elementKey).toBe('labels_b');
  });
});
