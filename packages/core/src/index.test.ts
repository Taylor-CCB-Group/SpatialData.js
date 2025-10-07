import { describe, expect, it } from 'vitest';
import { coordinateTransformationSchema, spatialDataSchema } from './schemas/index.js';

describe('SpatialData Core', () => {
  describe('schemas', () => {
    it('should validate coordinate transformation', () => {
      const validTransform = {
        type: 'affine',
        transform: [
          [1, 0],
          [0, 1],
        ],
      };

      expect(() => coordinateTransformationSchema.parse(validTransform)).not.toThrow();
    });

    it('should validate spatial data metadata', () => {
      const validMetadata = {
        version: '0.1.0',
        coordinateSystems: {
          global: {
            type: 'affine',
            transform: [
              [1, 0],
              [0, 1],
            ],
          },
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
