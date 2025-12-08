import { Matrix4 } from '@math.gl/core';
import type { CoordinateTransformation } from '../schemas';

export abstract class BaseTransformation {
  // abstract toArray(): number[];
  
  // toMatrix() {
  //   return new Matrix4().fromArray(this.toArray());
  // }
}

export class Identity extends BaseTransformation {
  toArray() {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }
}
export class MapAxis extends BaseTransformation {}
export class Translation extends BaseTransformation {}
export class Scale extends BaseTransformation {}
export class Affine extends BaseTransformation {}
export class Sequence extends BaseTransformation {}

// ============================================
// Matrix Building Utilities
// ============================================

/**
 * Single transformation entry from the CoordinateTransformation schema.
 * The schema is an array of these.
 */
type TransformEntry = CoordinateTransformation[number];

/**
 * Pad a 2D affine matrix (3x3) to a 4x4 matrix.
 * The 3x3 is expected in row-major form:
 * [[a, b, tx], [c, d, ty], [0, 0, 1]]
 * 
 * Output is column-major for Matrix4.
 */
function padAffine3x3To4x4(affine3x3: number[][]): number[] {
  const [[a, b, tx], [c, d, ty]] = affine3x3;
  // Matrix4 expects column-major order
  return [
    a,  c,  0, 0,  // column 0
    b,  d,  0, 0,  // column 1
    0,  0,  1, 0,  // column 2 (Z identity)
    tx, ty, 0, 1,  // column 3 (translation)
  ];
}

/**
 * Pad a 3D affine matrix (4x4) to column-major array.
 * Input is row-major [[a,b,c,tx],[d,e,f,ty],[g,h,i,tz],[0,0,0,1]]
 */
function affine4x4ToColumnMajor(affine4x4: number[][]): number[] {
  const result: number[] = [];
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      result.push(affine4x4[row]?.[col] ?? (row === col ? 1 : 0));
    }
  }
  return result;
}

/**
 * Build a single Matrix4 from an array of transformation entries.
 * All transforms are composed into a single 4x4 matrix.
 * 2D transforms (scale/translation with 2 components) are padded to 3D.
 * 
 * @param transforms - Array of transformation objects from the schema
 * @returns A Matrix4 representing the composed transformation
 */
export function buildMatrix4FromTransforms(transforms: CoordinateTransformation): Matrix4 {
  const matrix = new Matrix4().identity();
  
  for (const t of transforms) {
    applyTransformToMatrix(matrix, t);
  }
  
  return matrix;
}

/**
 * Apply a single transformation entry to a Matrix4 (mutates the matrix).
 */
function applyTransformToMatrix(matrix: Matrix4, t: TransformEntry): void {
  // Type guard to narrow the union
  if (!('type' in t)) return;
  
  switch (t.type) {
    case 'identity':
      // No-op
      break;
      
    case 'scale': {
      // Pad 2D scale [sx, sy] → [sx, sy, 1] for uniform 4x4 handling
      const [sx, sy, sz = 1] = t.scale;
      matrix.scale([sx, sy, sz]);
      break;
    }
    
    case 'translation': {
      // Pad 2D translation [tx, ty] → [tx, ty, 0]
      const [tx, ty, tz = 0] = t.translation;
      matrix.translate([tx, ty, tz]);
      break;
    }
    
    case 'affine': {
      const { affine } = t;
      let affineArray: number[];
      
      if (affine.length === 3 && affine[0].length === 3) {
        // 3x3 affine (2D) → pad to 4x4
        affineArray = padAffine3x3To4x4(affine);
      } else if (affine.length === 4 && affine[0].length === 4) {
        // 4x4 affine (3D) → convert to column-major
        affineArray = affine4x4ToColumnMajor(affine);
      } else {
        console.warn(`Unexpected affine matrix dimensions: ${affine.length}x${affine[0]?.length}`);
        return;
      }
      
      const affineMatrix = new Matrix4(affineArray);
      matrix.multiplyRight(affineMatrix);
      break;
    }
    
    case 'sequence': {
      // Recursively apply sequence of transforms
      for (const sub of t.transformations) {
        applyTransformToMatrix(matrix, sub as TransformEntry);
      }
      break;
    }
    
    default: {
      // Unknown transform type
      console.warn(`Unknown transform type: ${(t as { type: string }).type}`);
    }
  }
}

/**
 * Compose element-level and dataset-level transforms into a single Matrix4.
 * Useful for getting the full transform for a specific resolution level.
 * 
 * @param elementTransforms - Transforms from the element's spatialdata_attrs
 * @param datasetTransforms - Transforms from the specific dataset (resolution level)
 * @returns Combined Matrix4, or undefined if both inputs are undefined
 */
export function composeTransforms(
  elementTransforms?: CoordinateTransformation,
  datasetTransforms?: CoordinateTransformation
): Matrix4 | undefined {
  if (!elementTransforms && !datasetTransforms) {
    return undefined;
  }
  
  const matrix = new Matrix4().identity();
  
  // Apply dataset transforms first (inner), then element transforms (outer)
  // This follows the convention that dataset transforms go from pixel to element space,
  // then element transforms go from element space to coordinate system
  if (datasetTransforms) {
    const datasetMatrix = buildMatrix4FromTransforms(datasetTransforms);
    matrix.multiplyRight(datasetMatrix);
  }
  
  if (elementTransforms) {
    const elementMatrix = buildMatrix4FromTransforms(elementTransforms);
    matrix.multiplyRight(elementMatrix);
  }
  
  return matrix;
}