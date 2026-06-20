export {
  buildFeatureCatalogInWorker,
  decodeParquetPartsInWorker,
  disablePointsWorker,
  enablePointsWorker,
  ensurePointsWorker,
  filterColumnarByFeatureCodesInWorker,
  isPointsWorkerEnabled,
  setPointsWorkerDefaultEnabled,
} from './pointsWorkerClient.js';

export type { PointsWorkerMessage, PointsWorkerRequest, PointsWorkerResponse } from './pointsWorkerProtocol.js';
