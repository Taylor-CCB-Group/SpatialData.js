import type { SpatialData } from '@spatialdata/core';

/**
 * Physical length of one view unit, as Viv's `ScaleBarLayer` takes it with `snap`:
 * `unit` is `m` or an SI prefix + `m`.
 */
export interface ScaleBarSize {
  size: number;
  unit: string;
}

/** The parts of a parsed transformation the unit is read from. */
export interface TransformationOutput {
  output?: { axes?: ReadonlyArray<{ type?: unknown; unit?: unknown }> };
}

const SI_PREFIX_SYMBOLS: Record<string, string> = {
  yocto: 'y',
  zepto: 'z',
  atto: 'a',
  femto: 'f',
  pico: 'p',
  nano: 'n',
  micro: 'µ',
  milli: 'm',
  centi: 'c',
  deci: 'd',
  '': '',
  hecto: 'h',
  kilo: 'k',
  mega: 'M',
  giga: 'G',
  tera: 'T',
  peta: 'P',
  exa: 'E',
  zetta: 'Z',
  yotta: 'Y',
};

// OME-NGFF length units that aren't an SI prefix on metre, given in metres.
const NON_SI_METRES: Record<string, number> = {
  angstrom: 1e-10,
  inch: 0.0254,
  foot: 0.3048,
  yard: 0.9144,
  mile: 1609.344,
  parsec: 3.0857e16,
};

const VIV_SYMBOLS = new Set(Object.values(SI_PREFIX_SYMBOLS).map((prefix) => `${prefix}m`));

/**
 * Viv's scale bar size for one unit of `unit`: an OME-NGFF (UDUNITS-2) length name such as
 * `micrometer`, or a symbol Viv already reads (`µm`, `um`, `nm`, …). Anything else,
 * including SpatialData's `"unit"` placeholder, is not a length and gives `undefined`.
 */
export function scaleBarSizeForUnit(unit: string | undefined): ScaleBarSize | undefined {
  if (!unit) return undefined;
  const symbol = unit === 'um' ? 'µm' : unit;
  if (VIV_SYMBOLS.has(symbol)) {
    return { size: 1, unit: symbol };
  }
  const prefix = unit.match(/^([a-z]*)(?:meter|metre)$/)?.[1];
  if (prefix !== undefined && Object.hasOwn(SI_PREFIX_SYMBOLS, prefix)) {
    return { size: 1, unit: `${SI_PREFIX_SYMBOLS[prefix]}m` };
  }
  if (Object.hasOwn(NON_SI_METRES, unit)) {
    return { size: NON_SI_METRES[unit], unit: 'm' };
  }
  return undefined;
}

/**
 * The length unit of a coordinate system, from the spatial output axes of the transforms
 * into it. Axes without a length unit (none, or the `"unit"` placeholder) say nothing; if
 * the rest name more than one length (aliases such as `micrometer` and `µm` are one),
 * there is no single unit and this returns `undefined`.
 */
export function coordinateSystemUnitFromTransforms(
  transforms: Iterable<TransformationOutput>
): string | undefined {
  // Keyed by the size each unit maps to, so aliases agree; the value is the first name seen.
  const units = new Map<string, string>();
  for (const transform of transforms) {
    for (const axis of transform.output?.axes ?? []) {
      if (axis.type !== 'space' || typeof axis.unit !== 'string') continue;
      const size = scaleBarSizeForUnit(axis.unit);
      const key = size && `${size.size} ${size.unit}`;
      if (key && !units.has(key)) units.set(key, axis.unit);
    }
  }
  return units.size === 1 ? units.values().next().value : undefined;
}

const ELEMENT_TYPES = ['images', 'labels', 'shapes', 'points'] as const;

function* transformsInto(
  spatialData: SpatialData,
  coordinateSystem: string
): Generator<TransformationOutput> {
  for (const elementType of ELEMENT_TYPES) {
    for (const element of Object.values(spatialData[elementType] ?? {})) {
      const transform = element.getTransformation(coordinateSystem);
      if (transform.ok) yield transform.value;
    }
  }
}

/**
 * The scale bar for a canvas drawing `coordinateSystem`: one view unit is one unit of the
 * coordinate system. `unitOverride` (a host's declared unit) wins over the metadata.
 */
export function resolveScaleBarSize(
  spatialData: SpatialData | null | undefined,
  coordinateSystem: string | null,
  unitOverride?: string
): ScaleBarSize | undefined {
  if (unitOverride !== undefined) {
    return scaleBarSizeForUnit(unitOverride);
  }
  if (!spatialData || !coordinateSystem) return undefined;
  return scaleBarSizeForUnit(
    coordinateSystemUnitFromTransforms(transformsInto(spatialData, coordinateSystem))
  );
}
