import { Matrix4 } from '@math.gl/core';
import type { CoordinateTransformation, Axis } from '../schemas';

/**
 * Coordinate system reference from NGFF transformations.
 * @see https://github.com/ome/ngff/blob/main/rfc/5/versions/1/index.md
 * 
 * Note: `axes` is optional for backward compatibility with older NGFF data, but should be provided
 * for proper transformation handling when coordinate systems include non-spatial axes (e.g., "cyx").
 * Without axes, transformations fall back to direct mapping which assumes all values are spatial.
 * ^^ Do we really need to be supporting this? ^^
 */
export interface CoordinateSystemRef {
  name: string;
  axes?: Axis[];
}

/**
 * Map spatial axis values to XYZ coordinates based on axis names.
 * 
 * Axes should be validated to have proper `type` fields by the time they reach this function.
 * We check `type === 'space'` to identify spatial axes and map them by name to x, y, z coordinates.
 * 
 * Note: Future work could handle mixed units (e.g., different spatial units like 'micrometer' vs 'meter')
 * by converting to a common unit for order-of-magnitude consistency in transformations.
 * 
 * @param values - Full transformation value array (ordered according to input axes)
 * @param axes - Array of axis definitions (should be validated Axis types)
 * @param defaultValue - Default value to use when padding (1 for scale, 0 for translation)
 * @returns Array of [x, y, z] values mapped based on axis names
 */
function mapSpatialValuesToXYZ(
  values: number[],
  axes?: Axis[],
  defaultValue = 1
): [number, number, number] {
  if (!axes || axes.length === 0) {
    // No axes specified - use direct mapping (backward compatibility)
    console.warn("legacy data with no input axis specification - not really expecting to get here?")
    const [x = defaultValue, y = defaultValue, z = defaultValue] = values;
    return [x, y, z];
  }
  
  // Map values to Matrix4 dimensions based on axis name
  // Matrix4 uses standard x, y, z ordering
  let xValue = defaultValue;
  let yValue = defaultValue;
  let zValue = defaultValue;
  
  // Track spatial axes in order for fallback mapping
  const spatialAxesInOrder: Array<{ name: string; value: number }> = [];
  
  for (let i = 0; i < axes.length && i < values.length; i++) {
    const axis = axes[i];
    if (axis.type === 'space') {
      const axisName = axis.name.toLowerCase();
      const value = values[i] ?? defaultValue;
      
      // Map by exact axis name match (most common case: "x", "y", "z")
      if (axisName === 'x' && xValue === defaultValue) {
        xValue = value;
      } else if (axisName === 'y' && yValue === defaultValue) {
        yValue = value;
      } else if (axisName === 'z' && zValue === defaultValue) {
        zValue = value;
      } else {
        // Store for fallback mapping if name doesn't match exactly
        spatialAxesInOrder.push({ name: axisName, value });
      }
    }
  }
  
  // Fallback: if we have unmapped spatial axes, map them in order
  // This handles cases where axis names don't match x/y/z exactly
  // but preserves the spatial ordering (first → x, second → y, third → z)
  let fallbackIndex = 0;
  for (const { value } of spatialAxesInOrder) {
    if (fallbackIndex === 0 && xValue === defaultValue) {
      xValue = value;
    } else if (fallbackIndex === 1 && yValue === defaultValue) {
      yValue = value;
    } else if (fallbackIndex === 2 && zValue === defaultValue) {
      zValue = value;
    }
    fallbackIndex++;
  }
  
  return [xValue, yValue, zValue];
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
    // Transformation values are ordered according to the input coordinate system axes.
    // For example, if input axes are ["c", "y", "x"], then translation[0] corresponds to "c",
    // translation[1] to "y", and translation[2] to "x". We map spatial values to Matrix4
    // dimensions based on axis names (x→x, y→y, z→z) to preserve correct orientation.
    const [tx, ty, tz] = mapSpatialValuesToXYZ(this.translation, this.input?.axes, 0);
    
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
    // Transformation values are ordered according to the input coordinate system axes.
    // For example, if input axes are ["c", "y", "x"], then scale[0] corresponds to "c",
    // scale[1] to "y", and scale[2] to "x". We map spatial values to Matrix4
    // dimensions based on axis names (x→x, y→y, z→z) to preserve correct orientation.
    const [sx, sy, sz] = mapSpatialValuesToXYZ(this.scale, this.input?.axes);
    
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
    
    // Validate that affine matrix dimensions match expected spatial dimensions
    // when axes are specified. We assume affine matrices already represent spatial dimensions only.
    if (this.input?.axes) {
      const expectedSpatialDims = this.input.axes.filter(axis => axis.type === 'space').length;
      const actualDims = affine.length;
      
      // For 2D affine: 2x3 or 3x3 matrices
      // For 3D affine: 3x4 or 4x4 matrices
      // Warn if there's a mismatch
      if (expectedSpatialDims === 2 && actualDims !== 2 && actualDims !== 3) {
        console.warn(
          `Affine matrix dimensions (${actualDims}x${affine[0]?.length}) don't match expected 2D spatial dimensions. Input axes indicate ${expectedSpatialDims} spatial dimensions. Assuming affine matrix represents spatial dimensions only.`
        );
      } else if (expectedSpatialDims === 3 && actualDims !== 3 && actualDims !== 4) {
        console.warn(
          `Affine matrix dimensions (${actualDims}x${affine[0]?.length}) don't match expected 3D spatial dimensions. Input axes indicate ${expectedSpatialDims} spatial dimensions. Assuming affine matrix represents spatial dimensions only.`
        );
      }
    }
    
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
      // The third row should be [0, 0, 1] for a valid 2D homogeneous affine matrix
      const [[a, b, tx], [c, d, ty], [h0, h1, h2]] = affine;
      if (h0 !== 0 || h1 !== 0 || h2 !== 1) {
        console.warn(`Non-standard homogeneous row in 3x3 affine: [${h0}, ${h1}, ${h2}], expected [0, 0, 1]`);
      }
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

    if (affine.length === 3 && affine[0].length === 4) {
      // 3x4 affine (3D with implicit homogeneous row [0, 0, 0, 1])
      // Convert row-major to column-major, adding the implicit 4th row
      const result: number[] = [];
      // Process first 3 columns from the 3 rows
      for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 3; row++) {
          result.push(affine[row]?.[col] ?? 0);
        }
        // Add the implicit 4th row value: 0 for first 3 columns, 1 for last column
        result.push(col === 3 ? 1 : 0);
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