import { describe, expect, it } from 'vitest';
import {
  validateAndConvertV2Zarray,
  validateV3Zarray,
  v2ZarraySchema,
  v3ZarraySchema,
} from '../src/zarrSchema.js';

describe('zarrextra - Zarr Schema Validation', () => {
  describe('v2ZarraySchema', () => {
    it('should validate v2 zarray with filters and compressor', () => {
      const zarray = {
        shape: [100],
        chunks: [10],
        dtype: 'float64',
        filters: [{ id: 'delta', configuration: { dtype: 'float64' } }],
        compressor: { id: 'blosc', configuration: { cname: 'lz4' } },
      };

      expect(() => v2ZarraySchema.parse(zarray)).not.toThrow();
      const result = v2ZarraySchema.parse(zarray);
      expect(result.filters).toHaveLength(1);
      expect(result.compressor?.id).toBe('blosc');
    });

    it('should reject v2 zarray with mismatched shape/chunks length', () => {
      const invalidZarray = {
        shape: [100, 200],
        chunks: [10], // Wrong length
        dtype: 'float64',
      };

      expect(() => v2ZarraySchema.parse(invalidZarray)).toThrow();
    });

    it('should reject v2 zarray with negative shape dimensions', () => {
      const invalidZarray = {
        shape: [-1, 100],
        chunks: [10, 20],
        dtype: 'float64',
      };

      expect(() => v2ZarraySchema.parse(invalidZarray)).toThrow();
    });

    it('should reject v2 zarray with non-positive chunks', () => {
      const invalidZarray = {
        shape: [100],
        chunks: [0], // Must be positive
        dtype: 'float64',
      };

      expect(() => v2ZarraySchema.parse(invalidZarray)).toThrow();
    });

    it('should reject v2 zarray with missing required fields', () => {
      const invalidZarray = {
        shape: [100],
        // Missing chunks and dtype
      };

      expect(() => v2ZarraySchema.parse(invalidZarray)).toThrow();
    });

    it('should validate v2 zarray with dimension_names matching shape length', () => {
      const zarray = {
        shape: [100, 200],
        chunks: [10, 20],
        dtype: 'float64',
        dimension_names: ['y', 'x'],
      };

      expect(() => v2ZarraySchema.parse(zarray)).not.toThrow();
      const result = v2ZarraySchema.parse(zarray);
      expect(result.dimension_names).toEqual(['y', 'x']);
    });

    it('should reject v2 zarray with dimension_names length mismatch', () => {
      const invalidZarray = {
        shape: [100, 200],
        chunks: [10, 20],
        dtype: 'float64',
        dimension_names: ['y'], // Wrong length
      };

      expect(() => v2ZarraySchema.parse(invalidZarray)).toThrow();
    });

    it('should validate v2 zarray with null fill_value', () => {
      const zarray = {
        shape: [100],
        chunks: [10],
        dtype: 'float64',
        fill_value: null, // Valid for v2
      };

      expect(() => v2ZarraySchema.parse(zarray)).not.toThrow();
      const result = v2ZarraySchema.parse(zarray);
      expect(result.fill_value).toBeNull();
    });
  });

  describe('v3ZarraySchema', () => {
    it('should validate v3 zarray with codecs', () => {
      const zarray = {
        shape: [100],
        data_type: 'float64',
        chunk_grid: {
          name: 'regular',
          configuration: { chunk_shape: [10] },
        },
        codecs: [{ name: 'blosc', configuration: { cname: 'lz4' } }],
      };

      expect(() => v3ZarraySchema.parse(zarray)).not.toThrow();
      const result = v3ZarraySchema.parse(zarray);
      expect(result.codecs).toHaveLength(1);
      expect(result.codecs?.[0]?.name).toBe('blosc');
    });

    it('should reject v3 zarray with mismatched shape/chunk_shape length', () => {
      const invalidZarray = {
        shape: [100, 200],
        data_type: 'float64',
        chunk_grid: {
          name: 'regular',
          configuration: { chunk_shape: [10] }, // Wrong length
        },
      };

      expect(() => v3ZarraySchema.parse(invalidZarray)).toThrow();
    });

    it('should reject v3 zarray with missing required fields', () => {
      const invalidZarray = {
        shape: [100],
        // Missing data_type and chunk_grid
      };

      expect(() => v3ZarraySchema.parse(invalidZarray)).toThrow();
    });
  });

  describe('validateAndConvertV2Zarray', () => {
    it('should convert valid v2 zarray to v3 format', () => {
      const v2Zarray = {
        shape: [100, 200],
        chunks: [10, 20],
        dtype: 'float64',
        fill_value: 0,
        zarr_format: 2,
      };

      const result = validateAndConvertV2Zarray(v2Zarray, 'test/path');

      expect(result.shape).toEqual([100, 200]);
      expect(result.data_type).toBe('float64');
      expect(result.chunk_grid.configuration.chunk_shape).toEqual([10, 20]);
      expect(result.chunk_grid.name).toBe('regular');
      expect(result.chunk_key_encoding.name).toBe('default');
      expect(result.zarr_format).toBe(3);
      expect(result.node_type).toBe('array');
    });

    it('should convert v2 filters and compressor to v3 codecs', () => {
      const v2Zarray = {
        shape: [100],
        chunks: [10],
        dtype: 'float64',
        filters: [{ id: 'delta', configuration: { dtype: 'float64' } }],
        compressor: { id: 'blosc', configuration: { cname: 'lz4' } },
      };

      const result = validateAndConvertV2Zarray(v2Zarray, 'test/path');

      expect(result.codecs).toHaveLength(2);
      expect(result.codecs[0]?.name).toBe('delta');
      expect(result.codecs[1]?.name).toBe('blosc');
    });

    it('should handle v2 zarray with dimension_names', () => {
      const v2Zarray = {
        shape: [100, 200],
        chunks: [10, 20],
        dtype: 'float64',
        dimension_names: ['y', 'x'],
      };

      const result = validateAndConvertV2Zarray(v2Zarray, 'test/path');

      expect(result.dimension_names).toEqual(['y', 'x']);
    });

    it('should handle v2 zarray with null fill_value', () => {
      const v2Zarray = {
        shape: [100],
        chunks: [10],
        dtype: 'float64',
        fill_value: null, // Valid for v2
      };

      const result = validateAndConvertV2Zarray(v2Zarray, 'test/path');
      // Note: validateAndConvertV2Zarray converts null fill_value to 0 default
      // This is expected behavior for the conversion function
      expect(result.fill_value).toBe(0);
    });

    it('should handle v2 zarray that is already in v3 format (hybrid)', () => {
      const hybridZarray = {
        shape: [100],
        data_type: 'float64',
        chunk_grid: {
          name: 'regular',
          configuration: { chunk_shape: [10] },
        },
        // Missing v2 fields (chunks, dtype)
      };

      // Should use v3 validation path
      const result = validateAndConvertV2Zarray(hybridZarray, 'test/path');
      expect(result.data_type).toBe('float64');
      expect(result.chunk_grid.configuration.chunk_shape).toEqual([10]);
    });
  });

  describe('validateV3Zarray', () => {
    it('should provide default chunk_key_encoding if missing', () => {
      const v3Zarray = {
        shape: [100],
        data_type: 'float64',
        chunk_grid: {
          name: 'regular',
          configuration: { chunk_shape: [10] },
        },
        // Missing chunk_key_encoding
      };

      const result = validateV3Zarray(v3Zarray, 'test/path');

      expect(result.chunk_key_encoding.name).toBe('default');
      expect(result.chunk_key_encoding.configuration.separator).toBe('/');
    });

    it('should preserve provided optional fields', () => {
      const v3Zarray = {
        shape: [100],
        data_type: 'float64',
        chunk_grid: {
          name: 'regular',
          configuration: { chunk_shape: [10] },
        },
        fill_value: 42,
        codecs: [{ name: 'blosc' }],
        dimension_names: ['x'],
      };

      const result = validateV3Zarray(v3Zarray, 'test/path');

      expect(result.fill_value).toBe(42);
      expect(result.codecs).toHaveLength(1);
      expect(result.dimension_names).toEqual(['x']);
    });
  });
});
