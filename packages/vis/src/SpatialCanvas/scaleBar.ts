import {
  getNodeAttrs,
  type PhysicalLength,
  physicalLengthOfUnit,
  type Result,
} from '@spatialdata/core';

/**
 * Physical length of one view unit, as Viv's `ScaleBarLayer` takes it with `snap`:
 * `unit` is `m` or an SI prefix + `m`.
 */
export type ScaleBarSize = PhysicalLength;

/**
 * What a host can declare one coordinate-system unit to be: a length unit name or symbol
 * (`'micrometer'`, `'µm'`), or a size of one (`{ size: 0.2125, unit: 'µm' }`).
 */
export type CoordinateSystemUnit = string | PhysicalLength;

/** The parts of a parsed transformation the unit is read from. */
export interface TransformationOutput {
  output?: { axes?: ReadonlyArray<{ type?: unknown; unit?: unknown }> };
}

interface ElementTransforms {
  getTransformation(
    coordinateSystem: string
  ): Result<TransformationOutput & { toArray(): number[] }, unknown>;
}

/** The parts of a `SpatialData` the scale bar reads. */
export interface ScaleBarSource {
  rootStore?: { tree?: unknown };
  images?: Record<string, ElementTransforms>;
  labels?: Record<string, ElementTransforms>;
  shapes?: Record<string, ElementTransforms>;
  points?: Record<string, ElementTransforms>;
}

function lengthOfDeclared(declared: CoordinateSystemUnit): ScaleBarSize | undefined {
  if (typeof declared === 'string') return physicalLengthOfUnit(declared);
  const unit = physicalLengthOfUnit(declared.unit);
  if (!unit || !(declared.size > 0) || !Number.isFinite(declared.size)) return undefined;
  return { size: declared.size * unit.size, unit: unit.unit };
}

/**
 * The length of one unit of a coordinate system, from the spatial output axes of the
 * transforms into it. Axes without a length unit (none, or the `"unit"` placeholder) say
 * nothing; if the rest name more than one length (aliases such as `micrometer` and `µm` are
 * one), there is no single length and this returns `undefined`.
 */
export function coordinateSystemLengthFromTransforms(
  transforms: Iterable<TransformationOutput>
): ScaleBarSize | undefined {
  const lengths = declaredLengths(transforms);
  return lengths.length === 1 ? lengths[0] : undefined;
}

/** The distinct lengths the spatial output axes declare; aliases of one length count once. */
function declaredLengths(transforms: Iterable<TransformationOutput>): ScaleBarSize[] {
  const lengths = new Map<string, ScaleBarSize>();
  for (const transform of transforms) {
    for (const axis of transform.output?.axes ?? []) {
      if (axis.type !== 'space') continue;
      const length = physicalLengthOfUnit(axis.unit);
      if (length) lengths.set(`${length.size} ${length.unit}`, length);
    }
  }
  return [...lengths.values()];
}

const SPATIAL_ELEMENT_TYPES = ['images', 'labels', 'shapes', 'points'] as const;

function* elementsOf(
  spatialData: ScaleBarSource,
  elementTypes: ReadonlyArray<(typeof SPATIAL_ELEMENT_TYPES)[number]>
) {
  for (const elementType of elementTypes) {
    yield* Object.values(spatialData[elementType] ?? {});
  }
}

function* transformsInto(spatialData: ScaleBarSource, coordinateSystem: string) {
  for (const element of elementsOf(spatialData, SPATIAL_ELEMENT_TYPES)) {
    const transform = element.getTransformation(coordinateSystem);
    if (transform.ok) yield transform.value;
  }
}

// spatialdata-io readers whose points and shapes are in µm, scaled by 1/pixel_size into
// morphology-pixel `global`, with every axis left as the "unit" placeholder.
const MICRON_POINTS_READERS = new Set(['xenium', 'atera']);

/**
 * One coordinate-system unit in µm for a store from a {@link MICRON_POINTS_READERS} reader:
 * the inverse of the scale its points and shapes share into `coordinateSystem`. Nothing if
 * any of them is not that one uniform scale.
 */
function lengthFromReaderConvention(
  spatialData: ScaleBarSource,
  coordinateSystem: string
): ScaleBarSize | undefined {
  const reader = getNodeAttrs(spatialData.rootStore?.tree)?.spatialdata_io_reader;
  if (typeof reader !== 'string' || !MICRON_POINTS_READERS.has(reader)) return undefined;
  const scales = new Set<number>();
  for (const element of elementsOf(spatialData, ['points', 'shapes'])) {
    const transform = element.getTransformation(coordinateSystem);
    if (!transform.ok) continue;
    // Column-major 4×4: a uniform xy scale has equal diagonal and no shear.
    const [sx, shearYX, , , shearXY, sy] = transform.value.toArray();
    if (shearYX !== 0 || shearXY !== 0 || sx !== sy || !(sx > 0)) return undefined;
    scales.add(sx);
  }
  const [scale] = scales;
  return scales.size === 1 ? { size: 1 / scale, unit: 'µm' } : undefined;
}

/**
 * The scale bar for a canvas drawing `coordinateSystem`: one view unit is one unit of the
 * coordinate system. `declared` (from the host) wins over the transforms' axis units, which
 * win over the xenium/atera reader convention. That convention is only a fallback for
 * undeclared units: axis units that conflict give no bar.
 */
export function resolveScaleBarSize(
  spatialData: ScaleBarSource | null | undefined,
  coordinateSystem: string | null,
  declared?: CoordinateSystemUnit
): ScaleBarSize | undefined {
  if (declared !== undefined) return lengthOfDeclared(declared);
  if (!spatialData || !coordinateSystem) return undefined;
  const lengths = declaredLengths(transformsInto(spatialData, coordinateSystem));
  if (lengths.length > 0) return lengths.length === 1 ? lengths[0] : undefined;
  return lengthFromReaderConvention(spatialData, coordinateSystem);
}
