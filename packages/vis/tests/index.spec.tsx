import { describe, expect, it } from 'vitest';
import * as VisExports from '../src/index.js';

describe('@spatialdata/vis', () => {
  it('should export SpatialCanvas component', () => {
    // SpatialCanvas is exported as a named export, not default
    expect(VisExports.SpatialCanvas).toBeDefined();
    expect(typeof VisExports.SpatialCanvas).toBe('function');
  });

  it('should export named components', () => {
    expect(VisExports.Sketch).toBeDefined();
    expect(VisExports.SpatialDataTree).toBeDefined();
    expect(VisExports.Transforms).toBeDefined();
    expect(VisExports.ImageView).toBeDefined();
    expect(VisExports.Shapes).toBeDefined();
    expect(VisExports.Table).toBeDefined();
  });

  it('should export SpatialCanvas hooks and utilities', () => {
    expect(VisExports.SpatialCanvasProvider).toBeDefined();
    expect(VisExports.useSpatialCanvasStore).toBeDefined();
    expect(VisExports.useSpatialCanvasActions).toBeDefined();
    expect(VisExports.useSpatialCanvasStoreApi).toBeDefined();
    expect(VisExports.createSpatialCanvasStore).toBeDefined();
    expect(VisExports.useSpatialViewState).toBeDefined();
    expect(VisExports.useViewStateUrl).toBeDefined();
  });

  it('should have all expected exports', () => {
    const exports = Object.keys(VisExports);
    expect(exports.length).toBeGreaterThan(0);
    // Check for key exports
    expect(exports).toContain('Sketch');
    expect(exports).toContain('SpatialDataTree');
    expect(exports).toContain('Transforms');
    expect(exports).toContain('ImageView');
    expect(exports).toContain('Shapes');
    expect(exports).toContain('Table');
    expect(exports).toContain('SpatialCanvasProvider');
  });
});
