import { Matrix4 } from '@math.gl/core';
import type { CoordinateTransformation } from '../schemas';

/**
 * Coordinate system reference from NGFF transformations.
 */
export interface CoordinateSystemRef {
  name: string;
  axes?: Array<{ name: string; type?: string; unit?: string }>;
}

/**
 * Base class for all transformation types.
 * Provides a common interface for converting to Matrix4.
 */
export abstract class BaseTransformation {
  /** Input coordinate system (element's intrinsic space) */
  readonly input?: CoordinateSystemRef;
  /** Output coordinate system (target space, e.g., "global") */
  readonly output?: CoordinateSystemRef;
  
  constructor(input?: CoordinateSystemRef, output?: CoordinateSystemRef) {
    this.input = input;
    this.output = output;
  }
  
  /** Get the transformation as a column-major 16-element array */
  abstract toArray(): number[];
  
  /** Get the transformation as a Matrix4 */
  toMatrix(): Matrix4 {
    return new Matrix4(this.toArray());
  }
  
  /** The transformation type name */
  abstract get type(): string;
}

export class Identity extends BaseTransformation {
  get type() { return 'identity' as const; }
  
  toArray(): number[] {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }
}

export class Translation extends BaseTransformation {
  readonly translation: number[];
  
  constructor(translation: number[], input?: CoordinateSystemRef, output?: CoordinateSystemRef) {
    super(input, output);
    this.translation = translation;
  }
  
  get type() { return 'translation' as const; }
  
  toArray(): number[] {
    const [tx, ty, tz = 0] = this.translation;
    return [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      tx, ty, tz, 1,
    ];
  }
}

export class Scale extends BaseTransformation {
  readonly scale: number[];
  
  constructor(scale: number[], input?: CoordinateSystemRef, output?: CoordinateSystemRef) {
    super(input, output);
    this.scale = scale;
  }
  
  get type() { return 'scale' as const; }
  
  toArray(): number[] {
    const [sx, sy, sz = 1] = this.scale;
    return [
      sx, 0, 0, 0,
      0, sy, 0, 0,
      0, 0, sz, 0,
      0, 0, 0, 1,
    ];
  }
}

export class Affine extends BaseTransformation {
  readonly affine: number[][];
  
  constructor(affine: number[][], input?: CoordinateSystemRef, output?: CoordinateSystemRef) {
    super(input, output);
    this.affine = affine;
  }
  
  get type() { return 'affine' as const; }
  
  toArray(): number[] {
    const { affine } = this;
    
    if (affine.length === 2 && affine[0].length === 3) {
      // 2x3 affine (2D) - common spatialdata format: [[a, b, tx], [c, d, ty]]
      const [[a, b, tx], [c, d, ty]] = affine;
      return [
        a, c, 0, 0,
        b, d, 0, 0,
        0, 0, 1, 0,
        tx, ty, 0, 1,
      ];
    }
    
    if (affine.length === 3 && affine[0].length === 3) {
      // 3x3 affine (2D with homogeneous row)
      const [[a, b, tx], [c, d, ty]] = affine;
      return [
        a, c, 0, 0,
        b, d, 0, 0,
        0, 0, 1, 0,
        tx, ty, 0, 1,
      ];
    }
    
    if (affine.length === 4 && affine[0].length === 4) {
      // 4x4 affine (3D) - convert row-major to column-major
      const result: number[] = [];
      for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
          result.push(affine[row]?.[col] ?? (row === col ? 1 : 0));
        }
      }
      return result;
    }
    
    console.warn(`Unexpected affine matrix dimensions: ${affine.length}x${affine[0]?.length}`);
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }
}

export class Sequence extends BaseTransformation {
  readonly transformations: BaseTransformation[];
  
  constructor(transformations: BaseTransformation[], input?: CoordinateSystemRef, output?: CoordinateSystemRef) {
    super(input, output);
    this.transformations = transformations;
  }
  
  get type() { return 'sequence' as const; }
  
  toArray(): number[] {
    const matrix = new Matrix4().identity();
    for (const t of this.transformations) {
      matrix.multiplyRight(t.toMatrix());
    }
    return Array.from(matrix);
  }
  
  toMatrix(): Matrix4 {
    const matrix = new Matrix4().identity();
    for (const t of this.transformations) {
      matrix.multiplyRight(t.toMatrix());
    }
    return matrix;
  }
}

// MapAxis is less common, stub for now
export class MapAxis extends BaseTransformation {
  get type() { return 'mapAxis' as const; }
  
  toArray(): number[] {
    // TODO: implement axis mapping
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }
}

// ============================================
// Parsing: CoordinateTransformation → BaseTransformation
// ============================================

/**
 * Single transformation entry from the CoordinateTransformation schema.
 */
type TransformEntry = CoordinateTransformation[number];

/**
 * Parse a single transformation entry from the schema into a BaseTransformation instance.
 */
export function parseTransformEntry(t: TransformEntry): BaseTransformation {
  if (!('type' in t)) {
    return new Identity();
  }
  
  const input = (t as { input?: CoordinateSystemRef }).input;
  const output = (t as { output?: CoordinateSystemRef }).output;
  
  switch (t.type) {
    case 'identity':
      return new Identity(input, output);
      
    case 'scale':
      return new Scale(t.scale, input, output);
      
    case 'translation':
      return new Translation(t.translation, input, output);
      
    case 'affine':
      return new Affine(t.affine, input, output);
      
    case 'sequence': {
      const children = t.transformations.map((sub: TransformEntry) => parseTransformEntry(sub));
      return new Sequence(children, input, output);
    }
    
    default:
      console.warn(`Unknown transform type: ${(t as { type: string }).type}`);
      return new Identity(input, output);
  }
}

/**
 * Parse a CoordinateTransformation array into BaseTransformation instances.
 * If there's a single transform, returns it directly.
 * If there are multiple, wraps them in a Sequence.
 * 
 * @param transforms - Array of transformation objects from the schema
 * @returns A BaseTransformation instance
 */
export function parseTransforms(transforms: CoordinateTransformation): BaseTransformation {
  if (transforms.length === 0) {
    return new Identity();
  }
  
  if (transforms.length === 1) {
    return parseTransformEntry(transforms[0]);
  }
  
  // Multiple transforms → wrap in a Sequence
  const parsed = transforms.map(parseTransformEntry);
  // Use the first transform's input and last transform's output
  const input = parsed[0].input;
  const output = parsed[parsed.length - 1].output;
  return new Sequence(parsed, input, output);
}

// ============================================
// Matrix Building Utilities
// ============================================

/**
 * Build a single Matrix4 from an array of transformation entries.
 * All transforms are composed into a single 4x4 matrix.
 * 
 * @param transforms - Array of transformation objects from the schema
 * @returns A Matrix4 representing the composed transformation
 */
export function buildMatrix4FromTransforms(transforms: CoordinateTransformation): Matrix4 {
  return parseTransforms(transforms).toMatrix();
}

/**
 * Compose element-level and dataset-level transforms into a single Matrix4.
 * Useful for getting the full transform for a specific resolution level.
 * 
 * @param elementTransforms - Transforms from the element level
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
    matrix.multiplyRight(parseTransforms(datasetTransforms).toMatrix());
  }
  
  if (elementTransforms) {
    matrix.multiplyRight(parseTransforms(elementTransforms).toMatrix());
  }
  
  return matrix;
}