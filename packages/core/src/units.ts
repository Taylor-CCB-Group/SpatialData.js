/** A physical length: `size` of `unit`, where `unit` is `m` or an SI prefix + `m` (`µm`, `nm`, …). */
export interface PhysicalLength {
  size: number;
  unit: string;
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

const METRE_SYMBOLS = new Set(Object.values(SI_PREFIX_SYMBOLS).map((prefix) => `${prefix}m`));

/**
 * The length of one `unit`: an OME-NGFF (UDUNITS-2) length name such as `micrometer`, or a
 * symbol (`µm`, `um`, `nm`, …). Anything else, including SpatialData's `"unit"` placeholder,
 * is not a length and gives `undefined`.
 */
export function physicalLengthOfUnit(unit: unknown): PhysicalLength | undefined {
  if (typeof unit !== 'string' || !unit) return undefined;
  const symbol = unit === 'um' ? 'µm' : unit;
  if (METRE_SYMBOLS.has(symbol)) {
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

/** An element's transform into `coordinateSystem` gives none of its spatial axes a length unit. */
export type CoordinateUnitIssue = {
  kind: 'no-length-unit';
  coordinateSystem: string;
  remedy: { op: 'declare-length-unit'; coordinateSystem: string };
};

/** {@link CoordinateUnitIssue}s for an element's transforms, keyed by coordinate system. */
export function assessCoordinateUnits(
  transforms: ReadonlyMap<
    string,
    { output?: { axes?: ReadonlyArray<{ type?: unknown; unit?: unknown }> } }
  >
): CoordinateUnitIssue[] {
  const issues: CoordinateUnitIssue[] = [];
  for (const [coordinateSystem, transform] of transforms) {
    const hasLength = transform.output?.axes?.some(
      (axis) => axis.type === 'space' && physicalLengthOfUnit(axis.unit) !== undefined
    );
    if (!hasLength) {
      issues.push({
        kind: 'no-length-unit',
        coordinateSystem,
        remedy: { op: 'declare-length-unit', coordinateSystem },
      });
    }
  }
  return issues;
}

export function describeCoordinateUnitIssue(issue: CoordinateUnitIssue): string {
  return `Coordinate system '${issue.coordinateSystem}' declares no length unit, so its physical scale is unknown or inferred.`;
}
