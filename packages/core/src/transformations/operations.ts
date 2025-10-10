import type { SpatialElement } from "../store";
import { Identity, type BaseTransformation } from "./transformations";


const DEFAULT_COORDINATE_SYSTEM = 'global';

type MappingToCoordinateSytem_t = Map<string, BaseTransformation>;

function _getTransformationsFromDictContainer(element: SpatialElement) {

}

function _getTransformations(element: SpatialElement) {
  // in python, there are various `@_get_transformations.register(DataArray)` overloads
  // we could have something like `{ 'images' : getImageTransformations }` mapping,
}

/**
 * Get the transformation(s) for a given SpatialElement.
 */
export function getTransformation(element: SpatialElement, toCoordinateSystem?: string, getAll = false): BaseTransformation | Map<string, BaseTransformation> {
  // Map vs Record<string, ...> ?
  // Map is more 'correct' but Record is easier to use and we're not dealing with a huge number of keys
  // So maybe Record is actually better and looks more like the python dict.
  const map = new Map<string, BaseTransformation>();
  console.warn("getTransformation is not yet implemented; returning a placeholder value.");
  map.set(DEFAULT_COORDINATE_SYSTEM, new Identity());
  map.set('fake_cs', new Identity());
  return map;
}
