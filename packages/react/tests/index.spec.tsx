import { describe, expect, it } from 'vitest';
import * as ReactExports from '../src/index.js';

describe('@spatialdata/react', () => {
  it('should export useSpatialData hook', () => {
    expect(ReactExports.useSpatialData).toBeDefined();
    expect(typeof ReactExports.useSpatialData).toBe('function');
  });

  it('should export SpatialDataProvider component', () => {
    expect(ReactExports.SpatialDataProvider).toBeDefined();
    expect(typeof ReactExports.SpatialDataProvider).toBe('function');
  });

  it('should export useSpatialDataContext hook', () => {
    expect(ReactExports.useSpatialDataContext).toBeDefined();
    expect(typeof ReactExports.useSpatialDataContext).toBe('function');
  });

  it('should have all expected exports', () => {
    const exports = Object.keys(ReactExports);
    expect(exports.length).toBeGreaterThan(0);
    expect(exports).toContain('useSpatialData');
    expect(exports).toContain('SpatialDataProvider');
    expect(exports).toContain('useSpatialDataContext');
  });
});

