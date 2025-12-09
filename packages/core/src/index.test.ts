import { describe, expect, it } from 'vitest';
import { coordinateTransformationSchema, spatialDataSchema } from './schemas/index.js';

describe('SpatialData Core', () => {
  describe('schemas', () => {
    it('should validate coordinate transformation', () => {
      // coordinateTransformationSchema expects an array of transformations
      const validTransforms = [
        {
          type: 'affine',
          affine: [
            [1, 0, 0],
            [0, 1, 0],
          ],
        },
      ];

      expect(() => coordinateTransformationSchema.parse(validTransforms)).not.toThrow();
    });

    it('should validate spatial data metadata', () => {
      // coordinateSystems values are arrays of transformations
      const validMetadata = {
        version: '0.1.0',
        coordinateSystems: {
          global: [
            {
              type: 'affine',
              affine: [
                [1, 0, 0],
                [0, 1, 0],
              ],
            },
          ],
        },
      };

      expect(() => spatialDataSchema.parse(validMetadata)).not.toThrow();
    });

    it('should reject invalid spatial data metadata', () => {
      const invalidMetadata = {
        version: 123, // should be string
      };

      expect(() => spatialDataSchema.parse(invalidMetadata)).toThrow();
    });
  });
});
