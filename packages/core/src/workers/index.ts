export {
  buildFeatureCatalogInWorker,
  countFeatureCodesInWorker,
  decodeParquetPartsInWorker,
  decodeParquetRowFeatureCodesInWorker,
  disablePointsWorker,
  enablePointsWorker,
  ensurePointsWorker,
  filterColumnarByFeatureCodesInWorker,
  isPointsWorkerEnabled,
  scanParquetByFeatureCodesInWorker,
  scanParquetFeatureCountsInWorker,
  setPointsWorkerDefaultEnabled,
} from './pointsWorkerClient.js';

export type { PointsWorkerMessage, PointsWorkerRequest, PointsWorkerResponse, ParquetRowGroupBytesChunk } from './pointsWorkerProtocol.js';
