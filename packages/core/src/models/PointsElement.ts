import { AbstractSpatialElement, type ElementParams } from '.';
import { type PointsAttrs, pointsAttrsSchema, type CoordinateTransformation } from '../schemas';
import SpatialDataPointsSource from './VPointsSource';


/**
 * Element representing point data (transcripts etc).
 */
export class PointsElement extends AbstractSpatialElement<'points', PointsAttrs> {
  readonly attrs: PointsAttrs;
  private readonly vPoints: SpatialDataPointsSource;
  constructor(params: ElementParams<'points'>) {
    super(params);

    // Parse attrs through schema
    const result = pointsAttrsSchema.safeParse(this.rawAttrs);
    if (!result.success) {
      console.warn(`Schema validation failed for points/${params.key}:`, result.error.issues);
      this.attrs = this.rawAttrs as PointsAttrs;
    } else {
      this.attrs = result.data;
    }
    this.vPoints = new SpatialDataPointsSource({
      store: params.sdata.rootStore,
      fileType: '.zarr'
    });
  }

  /**
   * Transformations are at attrs.coordinateTransformations with input/output refs.
   */
  protected get rawCoordinateTransformations(): CoordinateTransformation | undefined {
    return this.attrs.coordinateTransformations;
  }

  async loadPoints() {
    //Error: Unexpected response status 500 INTERNAL SERVER ERROR
    //IsADirectoryError: [Errno 21] Is a directory: '/MySpatialData.zarr/points/key/points.parquet'
    //we have points.parquet/part.0.parquet etc.
    return this.vPoints.loadPoints(`points/${this.key}`);
  }
}
