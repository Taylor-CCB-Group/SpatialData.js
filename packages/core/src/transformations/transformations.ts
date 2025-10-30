import { Matrix4 } from '@math.gl/core';

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