/**
 * OME-Zarr transformations conformance "dingus" for SpatialData.js.
 *
 * Implements the CLI contract from
 *   https://github.com/clbarnes/ome_zarr_transformations_conformance
 * Last four positional args MUST be: PATH SOURCE TARGET COORDINATES
 *   PATH         path to an OME-Zarr hierarchy (dir containing zarr.json) or a
 *                zarr.json file directly
 *   SOURCE       name of the source coordinate system
 *   TARGET       name of the target coordinate system
 *   COORDINATES  JSON array of D-length arrays (D = SOURCE axis count)
 *
 * On success prints a JSON Response {"coordinates": [...]} and exits 0.
 * On any unsupported feature / failure prints {"message": "..."} and exits 1.
 *
 * What this wraps: the transform primitives in
 *   packages/core/src/transformations/transformations.ts
 * (`parseTransformEntry` -> `BaseTransformation.toMatrix()`/`.inverse()`), i.e.
 * the actual SpatialData.js transform computation. SpatialData.js implements
 * identity/scale/translation/affine/rotation/mapAxis/sequence; byDimension/
 * bijection/displacements are NOT implemented and are reported as unsupported,
 * as are "by path" parameter forms (external zarr array references).
 *
 * Reverse-edge traversal uses `BaseTransformation.inverse()`, native to core.
 *
 * Run via Node type-stripping (Node >= 22):
 *   node --experimental-strip-types dev_scripts/conformance-dingus/dingus.ts \
 *     <PATH> <SOURCE> <TARGET> '<COORDS_JSON>'
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Type-only import: erased at runtime, so we never resolve @math.gl/core from
// outside packages/core (pnpm isolates it there). The Matrix4 *instances* come
// from parseTransformEntry(...).toMatrix(), and we only call instance methods.
import type { Matrix4 } from '@math.gl/core';
import {
  type CoordinateSystemRef,
  parseTransformEntry,
} from '../../packages/core/src/transformations/transformations.ts';

// SpatialData.js parseTransformEntry recognises exactly these (others -> Identity
// fallback). We treat anything else as explicitly unsupported.
const SUPPORTED_TYPES = new Set([
  'identity',
  'scale',
  'translation',
  'affine',
  'rotation',
  'mapAxis',
  'sequence',
]);

const AXIS_TO_XYZ: Record<string, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

interface Axis {
  name: string;
  type?: string;
  unit?: string;
}
interface CoordinateSystem {
  name: string;
  axes: Axis[];
}
interface TransformEdge {
  name?: string;
  type: string;
  input: { name: string };
  output: { name: string };
  [k: string]: unknown;
}
interface Scene {
  coordinateSystems: CoordinateSystem[];
  coordinateTransformations: TransformEdge[];
}

class DingusError extends Error {}

function emitError(message: string): never {
  process.stdout.write(JSON.stringify({ message }));
  process.exit(1);
}

function readScene(path: string): Scene {
  const jsonPath = path.endsWith('.json') ? path : join(path, 'zarr.json');
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    throw new DingusError(`could not read zarr.json at ${jsonPath}: ${String(err)}`);
  }
  const scene = (doc as { attributes?: { ome?: { scene?: Scene } } })?.attributes?.ome?.scene;
  if (!scene || !Array.isArray(scene.coordinateSystems)) {
    throw new DingusError(`no ome.scene with coordinateSystems at ${jsonPath}`);
  }
  return scene;
}

/** Build the spatial-axis -> XYZ index map for a coordinate system, validating. */
function spatialAxisIndices(cs: CoordinateSystem): Array<0 | 1 | 2> {
  const idx: Array<0 | 1 | 2> = [];
  for (const axis of cs.axes) {
    if (axis.type && axis.type !== 'space') {
      throw new DingusError(
        `coordinate system '${cs.name}' has non-spatial axis '${axis.name}' (unsupported)`
      );
    }
    const dim = AXIS_TO_XYZ[axis.name.toLowerCase()];
    if (dim === undefined) {
      throw new DingusError(
        `coordinate system '${cs.name}' axis '${axis.name}' is not x/y/z (unsupported)`
      );
    }
    idx.push(dim);
  }
  return idx;
}

/** A directed step along the path: which edge, and whether traversed in reverse. */
interface Step {
  edge: TransformEdge;
  reversed: boolean;
}

function findPath(scene: Scene, source: string, target: string): Step[] {
  if (source === target) return [];
  const adjacency = new Map<string, Array<{ to: string; step: Step }>>();
  const add = (from: string, to: string, step: Step) => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)!.push({ to, step });
  };
  for (const edge of scene.coordinateTransformations) {
    add(edge.input.name, edge.output.name, { edge, reversed: false });
    add(edge.output.name, edge.input.name, { edge, reversed: true });
  }

  // BFS for a shortest edge path.
  const queue: string[] = [source];
  const cameFrom = new Map<string, { from: string; step: Step }>();
  const seen = new Set<string>([source]);
  while (queue.length) {
    const node = queue.shift()!;
    if (node === target) break;
    for (const { to, step } of adjacency.get(node) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      cameFrom.set(to, { from: node, step });
      queue.push(to);
    }
  }
  if (!seen.has(target)) {
    throw new DingusError(`no transform path from '${source}' to '${target}'`);
  }
  const steps: Step[] = [];
  let node = target;
  while (node !== source) {
    const prev = cameFrom.get(node)!;
    steps.unshift(prev.step);
    node = prev.from;
  }
  return steps;
}

function stepMatrix(
  scene: Scene,
  csByName: Map<string, CoordinateSystem>,
  step: Step
): Matrix4 {
  const { edge, reversed } = step;
  if (!SUPPORTED_TYPES.has(edge.type)) {
    throw new DingusError(`transform type '${edge.type}' is not implemented by SpatialData.js`);
  }
  // Reject inline-parameter forms SpatialData.js cannot consume (notably the
  // RFC-5 "by path" forms where the matrix/parameters live in an external zarr
  // array referenced by `path`). SpatialData.js only reads inline parameters.
  if ('path' in edge && edge.path !== undefined) {
    throw new DingusError(
      `transform '${edge.name ?? edge.type}' stores parameters by path; ` +
        `external parameter arrays are not supported`
    );
  }
  if (edge.type === 'affine' && !Array.isArray((edge as { affine?: unknown }).affine)) {
    throw new DingusError(`affine transform missing inline 'affine' matrix (unsupported form)`);
  }
  if (edge.type === 'scale' && !Array.isArray((edge as { scale?: unknown }).scale)) {
    throw new DingusError(`scale transform missing inline 'scale' array (unsupported form)`);
  }
  if (
    edge.type === 'translation' &&
    !Array.isArray((edge as { translation?: unknown }).translation)
  ) {
    throw new DingusError(
      `translation transform missing inline 'translation' array (unsupported form)`
    );
  }
  if (
    edge.type === 'sequence' &&
    !Array.isArray((edge as { transformations?: unknown }).transformations)
  ) {
    throw new DingusError(`sequence transform missing inline 'transformations' (unsupported form)`);
  }
  const inCs = csByName.get(edge.input.name);
  const outCs = csByName.get(edge.output.name);
  if (!inCs || !outCs) {
    throw new DingusError(`edge references unknown coordinate system`);
  }
  // Inject axes so SpatialData.js maps values by axis name into XYZ.
  const input: CoordinateSystemRef = { name: inCs.name, axes: inCs.axes as never };
  const output: CoordinateSystemRef = { name: outCs.name, axes: outCs.axes as never };
  const entry = { ...edge, input, output };
  const transformation = parseTransformEntry(entry as never);
  if (!reversed) return transformation.toMatrix();

  // Reverse traversal: use SpatialData.js's native inverse() rather than a
  // dingus-level generic 4x4 invert.
  try {
    return transformation.inverse();
  } catch (err) {
    throw new DingusError(
      `transform '${edge.name ?? edge.type}' is not invertible: ${String(err)}`
    );
  }
}

function toXYZ(point: number[], indices: Array<0 | 1 | 2>): [number, number, number] {
  const vec: [number, number, number] = [0, 0, 0];
  if (point.length !== indices.length) {
    throw new DingusError(
      `coordinate has ${point.length} values but coordinate system has ${indices.length} axes`
    );
  }
  for (let i = 0; i < indices.length; i++) vec[indices[i]] = point[i]!;
  return vec;
}

function fromXYZ(vec: number[], indices: Array<0 | 1 | 2>): number[] {
  return indices.map((dim) => vec[dim]!);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length < 4) {
    throw new DingusError('expected at least 4 positional args: PATH SOURCE TARGET COORDINATES');
  }
  const [path, source, target, coordsJson] = argv.slice(-4) as [string, string, string, string];

  let coords: number[][];
  try {
    coords = JSON.parse(coordsJson);
  } catch (err) {
    throw new DingusError(`COORDINATES is not valid JSON: ${String(err)}`);
  }

  const scene = readScene(path);
  const csByName = new Map(scene.coordinateSystems.map((cs) => [cs.name, cs]));
  const sourceCs = csByName.get(source);
  const targetCs = csByName.get(target);
  if (!sourceCs) throw new DingusError(`unknown source coordinate system '${source}'`);
  if (!targetCs) throw new DingusError(`unknown target coordinate system '${target}'`);

  const sourceIdx = spatialAxisIndices(sourceCs);
  const targetIdx = spatialAxisIndices(targetCs);

  const steps = findPath(scene, source, target);
  const matrices = steps.map((step) => stepMatrix(scene, csByName, step));

  const out: number[][] = coords.map((point) => {
    let vec = toXYZ(point, sourceIdx);
    for (const m of matrices) {
      vec = m.transformAsPoint(vec, [0, 0, 0]) as [number, number, number];
    }
    const result = fromXYZ(vec, targetIdx);
    for (const v of result) {
      if (!Number.isFinite(v)) {
        throw new DingusError('non-finite coordinate produced');
      }
    }
    return result;
  });

  process.stdout.write(JSON.stringify({ coordinates: out }));
}

try {
  main();
} catch (err) {
  if (err instanceof DingusError) emitError(err.message);
  emitError(`unexpected error: ${String(err)}`);
}
