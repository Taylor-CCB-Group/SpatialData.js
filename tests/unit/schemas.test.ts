import { describe, expect, it } from 'vitest';
import {
  rasterAttrsSchema,
  coordinateTransformationSchema,
  shapesAttrsSchema,
  pointsAttrsSchema,
  tableAttrsSchema,
  spatialDataSchema,
} from '../../packages/core/src/schemas/index.js';

describe('Schema Transformations', () => {
  describe('rasterAttrsSchema - version normalization', () => {
    it('should normalize v0.6.1 format (nested under ome) to internal format', () => {
      const v061Format = {
        ome: {
          multiscales: [
            {
              name: 'test',
              datasets: [{ path: '0' }],
              axes: [
                { name: 'y', type: 'space' },
                { name: 'x', type: 'space' },
              ],
            },
          ],
        },
        spatialdata_attrs: {
          version: '0.6.1',
        },
      };

      const result = rasterAttrsSchema.parse(v061Format);

      // Should have multiscales at top level after transformation
      expect(result.multiscales).toBeDefined();
      expect(result.multiscales).toHaveLength(1);
      expect(result.multiscales[0].name).toBe('test');
      // Should not have 'ome' key in result
      expect('ome' in result).toBe(false);
    });

    it('should accept v0.5.0 format (top-level multiscales) as-is', () => {
      const v050Format = {
        multiscales: [
          {
            name: 'test',
            datasets: [{ path: '0' }],
            axes: [
              { name: 'y', type: 'space' },
              { name: 'x', type: 'space' },
            ],
          },
        ],
        spatialdata_attrs: {
          version: '0.5.0',
        },
      };

      const result = rasterAttrsSchema.parse(v050Format);

      // Should have multiscales at top level
      expect(result.multiscales).toBeDefined();
      expect(result.multiscales).toHaveLength(1);
      expect(result.multiscales[0].name).toBe('test');
    });

    it('should preserve omero data from v0.6.1 format', () => {
      const v061Format = {
        ome: {
          multiscales: [
            {
              name: 'test',
              datasets: [{ path: '0' }],
              axes: [
                { name: 'y', type: 'space' },
                { name: 'x', type: 'space' },
              ],
            },
          ],
          omero: {
            channels: [
              {
                label: 'channel1',
                color: 'FF0000',
              },
            ],
          },
        },
        spatialdata_attrs: {
          version: '0.6.1',
        },
      };

      const result = rasterAttrsSchema.parse(v061Format);

      expect(result.omero).toBeDefined();
      expect(result.omero?.channels).toHaveLength(1);
      expect(result.omero?.channels[0].label).toBe('channel1');
    });
  });

  describe('coordinateTransformationSchema', () => {
    it('should validate scale transformation', () => {
      const transform = [
        {
          type: 'scale' as const,
          scale: [1.0, 2.0, 3.0],
        },
      ];

      expect(() => coordinateTransformationSchema.parse(transform)).not.toThrow();
      const result = coordinateTransformationSchema.parse(transform);
      expect(result[0].type).toBe('scale');
    });

    it('should validate translation transformation', () => {
      const transform = [
        {
          type: 'translation' as const,
          translation: [10.0, 20.0],
        },
      ];

      expect(() => coordinateTransformationSchema.parse(transform)).not.toThrow();
    });

    it('should validate affine transformation', () => {
      const transform = [
        {
          type: 'affine' as const,
          affine: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
        },
      ];

      expect(() => coordinateTransformationSchema.parse(transform)).not.toThrow();
    });

    it('should validate identity transformation', () => {
      const transform = [
        {
          type: 'identity' as const,
        },
      ];

      expect(() => coordinateTransformationSchema.parse(transform)).not.toThrow();
    });

    it('should validate sequence transformation', () => {
      const transform = [
        {
          type: 'sequence' as const,
          transformations: [
            { type: 'scale' as const, scale: [2.0, 2.0] },
            { type: 'translation' as const, translation: [10.0, 10.0] },
          ],
        },
      ];

      expect(() => coordinateTransformationSchema.parse(transform)).not.toThrow();
    });

    it('should validate transformations with coordinate system references', () => {
      const transform = [
        {
          type: 'scale' as const,
          scale: [1.0, 2.0],
          input: {
            name: 'input_cs',
            axes: [
              { name: 'x', type: 'space' as const },
              { name: 'y', type: 'space' as const },
            ],
          },
          output: {
            name: 'output_cs',
          },
        },
      ];

      expect(() => coordinateTransformationSchema.parse(transform)).not.toThrow();
      const result = coordinateTransformationSchema.parse(transform);
      expect(result[0].input?.name).toBe('input_cs');
      expect(result[0].output?.name).toBe('output_cs');
    });

    it('should reject empty transformation array', () => {
      const transform: unknown[] = [];

      expect(() => coordinateTransformationSchema.parse(transform)).toThrow();
    });
  });

  describe('shapesAttrsSchema', () => {
    it('should validate shapes attrs with transformations', () => {
      const attrs = {
        'encoding-type': 'ngff:shapes',
        axes: ['x', 'y'],
        coordinateTransformations: [
          {
            type: 'scale' as const,
            scale: [1.0, 1.0],
          },
        ],
        spatialdata_attrs: {
          version: '0.6.1',
        },
      };

      expect(() => shapesAttrsSchema.parse(attrs)).not.toThrow();
    });

    it('should accept shapes attrs without transformations', () => {
      const attrs = {
        'encoding-type': 'ngff:shapes',
        axes: ['x', 'y'],
      };

      expect(() => shapesAttrsSchema.parse(attrs)).not.toThrow();
    });
  });

  describe('pointsAttrsSchema', () => {
    it('should validate points attrs with transformations', () => {
      const attrs = {
        'encoding-type': 'ngff:points',
        axes: ['x', 'y'],
        coordinateTransformations: [
          {
            type: 'translation' as const,
            translation: [10.0, 20.0],
          },
        ],
        spatialdata_attrs: {
          version: '0.6.1',
        },
      };

      expect(() => pointsAttrsSchema.parse(attrs)).not.toThrow();
    });
  });

  describe('tableAttrsSchema', () => {
    it('should validate table attrs', () => {
      const attrs = {
        instance_key: 'cell_id',
        region: 'shapes',
        region_key: 'region_id',
        'spatialdata-encoding-type': 'ngff:regions_table',
      };

      expect(() => tableAttrsSchema.parse(attrs)).not.toThrow();
    });

    it('should accept array region', () => {
      const attrs = {
        instance_key: 'cell_id',
        region: ['shapes1', 'shapes2'],
        region_key: 'region_id',
        'spatialdata-encoding-type': 'ngff:regions_table',
      };

      expect(() => tableAttrsSchema.parse(attrs)).not.toThrow();
    });
  });

  describe('spatialDataSchema', () => {
    it('should validate spatial data root metadata', () => {
      const metadata = {
        version: '0.1.0',
        coordinateSystems: {
          global: [
            {
              type: 'affine' as const,
              affine: [
                [1, 0, 0],
                [0, 1, 0],
              ],
            },
          ],
        },
      };

      expect(() => spatialDataSchema.parse(metadata)).not.toThrow();
      const result = spatialDataSchema.parse(metadata);
      expect(result.version).toBe('0.1.0');
      expect(result.coordinateSystems.global).toBeDefined();
    });

    it('should reject invalid version type', () => {
      const metadata = {
        version: 123, // should be string
        coordinateSystems: {},
      };

      expect(() => spatialDataSchema.parse(metadata)).toThrow();
    });
  });
});

