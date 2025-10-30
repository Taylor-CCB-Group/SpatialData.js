import type { SpatialElement } from "../store";
import { Identity, type BaseTransformation } from "./transformations";


const DEFAULT_COORDINATE_SYSTEM = 'global';
const TRANSFORM_KEY = "transform";

export type MappingToCoordinateSytem_t = Map<string, BaseTransformation>;

// python has this used for points and shapes
function _getTransformationsFromDictContainer(element: SpatialElement) { //'GeoDataFrame' | 'DaskDataFrame' in Python
  if (TRANSFORM_KEY in element) {
    return element[TRANSFORM_KEY];
  }
  return undefined;
}

function _getTransformationsXArray(element: SpatialElement) { //'DataArray' in Python

}

function _getTransformationForMultiscaleImage(element: SpatialElement) { //'DataTree' in Python
  // in python, there are various `@_get_transformations.register(DataType)` overloads
  // we could have something like `{ 'images' : getImageTransformations }` mapping...
  // or perhaps simpler to make SpatialElement be a class with a method for getting transformations?
  // if possible to do that without deviating too much from the python style that seems easy to use and understand.
  
}

function _getTransformations(element: SpatialElement) {
  // in python, there are various `@_get_transformations.register(DataArray)` overloads
  // we could have something like `{ 'images' : getImageTransformations }` mapping...
  // or perhaps simpler to make SpatialElement be a class with a method for getting transformations?
  // if possible to do that without deviating too much from the python style that seems easy to use and understand.
  // if we want to stick slavishly to following through the python logic that means that we
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
