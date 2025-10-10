

export abstract class BaseTransformation {}

export class Identity extends BaseTransformation {}
export class MapAxis extends BaseTransformation {}
export class Translation extends BaseTransformation {}
export class Scale extends BaseTransformation {}
export class Affine extends BaseTransformation {}
export class Sequence extends BaseTransformation {}