import { tableFromIPC, tableToIPC } from 'apache-arrow';
import {
  buildFeatureCatalogFromColumns,
} from '../pointsFeatures.js';
import {
  filterColumnarByFeatureCodes,
} from '../pointsTiling.js';
import { getParquetModule, type ParquetModule } from '../parquetWasmLoader.js';
import type { PointsWorkerMessage, PointsWorkerRequest, PointsWorkerResponse } from './pointsWorkerProtocol.js';
import {
  countFeatureCodesFromArray,
  decodeGeometryWithFeaturesFromPayload,
  decodeParquetPartsToTable,
  decodeParquetPayloadToTable,
  extractGeometryColumnar,
  extractRowFeatureCodesFromTable,
  histogramToSortedArrays,
  scanFeatureCatalogFromPayload,
  scanMortonTableInBounds,
  scanTableByFeatureCodes,
  scanTableFeatureCounts,
} from './pointsWorkerScan.js';

function toFloat32Array(values: ArrayLike<number>): Float32Array {
  if (values instanceof Float32Array) {
    return values;
  }
  return Float32Array.from(values);
}

function handleFilterColumnar(request: Extract<PointsWorkerRequest, { type: 'filterColumnarByFeatureCodes' }>) {
  const filtered = filterColumnarByFeatureCodes(
    {
      shape: request.zs ? [3, request.xs.length] : [2, request.xs.length],
      data: request.zs ? [request.xs, request.ys, request.zs] : [request.xs, request.ys],
    },
    request.featureCodes,
    request.sourceFeatureCodes
  );
  const xs = toFloat32Array(filtered.data[0]);
  const ys = toFloat32Array(filtered.data[1]);
  const zs = filtered.data[2] ? toFloat32Array(filtered.data[2]) : undefined;
  const shape: number[] =
    filtered.shape && filtered.shape.length > 0
      ? filtered.shape
      : zs
        ? [3, xs.length]
        : [2, xs.length];
  return {
    ok: true as const,
    result: {
      kind: 'columnar' as const,
      shape,
      xs,
      ys,
      ...(zs ? { zs } : {}),
    },
  };
}

async function handleDecodeParquet(
  request: Extract<PointsWorkerRequest, { type: 'decodeParquetParts' }>
): Promise<PointsWorkerResponse> {
  const { readParquet } = await getParquetModule();
  const merged = await decodeParquetPartsToTable(
    readParquet,
    request.parts,
    request.columns,
    request.maxRows
  );
  return {
    ok: true,
    result: {
      kind: 'parquetTable',
      tableIpc: tableToIPC(merged),
    },
  };
}

async function handleDecodeParquetRowFeatureCodes(
  request: Extract<PointsWorkerRequest, { type: 'decodeParquetRowFeatureCodes' }>
): Promise<PointsWorkerResponse> {
  const parquetModule = await getParquetModule();
  const table = await decodeParquetPayloadToTable(
    parquetModule.readParquet,
    parquetModule.readParquetRowGroup,
    request,
    request.columns,
    request.maxRows
  );
  const featureCodeByName = request.featureCodeEntries
    ? new Map(request.featureCodeEntries.map((entry) => [entry.name, entry.code]))
    : undefined;
  const codes = extractRowFeatureCodesFromTable(
    table,
    request.featureKey,
    request.featureCodeColumnName,
    featureCodeByName
  );
  return {
    ok: true,
    result: {
      kind: 'rowFeatureCodes',
      codes,
      numRows: table.numRows,
    },
  };
}

async function handleScanParquetFeatureCatalog(
  request: Extract<PointsWorkerRequest, { type: 'scanParquetFeatureCatalog' }>
): Promise<PointsWorkerResponse> {
  const parquetModule = await getParquetModule();
  const catalog = await scanFeatureCatalogFromPayload(
    parquetModule.readParquet,
    parquetModule.readParquetRowGroup,
    request
  );
  if (!catalog) {
    return { ok: false, error: 'No features found in parquet catalog scan' };
  }
  return { ok: true, result: { kind: 'catalog', catalog } };
}

async function handleDecodeParquetGeometryCapped(
  request: Extract<PointsWorkerRequest, { type: 'decodeParquetGeometryCapped' }>
): Promise<PointsWorkerResponse> {
  const parquetModule = await getParquetModule();
  const table = await decodeParquetPayloadToTable(
    parquetModule.readParquet,
    parquetModule.readParquetRowGroup,
    request,
    request.columns,
    request.maxRows
  );
  const geometry = extractGeometryColumnar(table, request.axisNames);
  const featureCodeByName = request.featureCodeEntries
    ? new Map(request.featureCodeEntries.map((entry) => [entry.name, entry.code]))
    : undefined;
  const featureCodes =
    request.featureKey !== undefined
      ? extractRowFeatureCodesFromTable(
          table,
          request.featureKey,
          request.featureCodeColumnName,
          featureCodeByName
        )
      : undefined;
  return {
    ok: true,
    result: {
      kind: 'columnar',
      ...geometry,
      ...(featureCodes ? { featureCodes } : {}),
    },
  };
}

async function handleDecodeGeometryWithFeatures(
  request: Extract<PointsWorkerRequest, { type: 'decodeGeometryWithFeatures' }>
): Promise<PointsWorkerResponse> {
  const parquetModule = await getParquetModule();
  const result = await decodeGeometryWithFeaturesFromPayload(
    parquetModule.readParquet,
    parquetModule.readParquetRowGroup,
    request
  );
  const [xs, ys, zs] = result.data;
  return {
    ok: true,
    result: {
      kind: 'geometryWithFeatures',
      shape: result.shape,
      xs,
      ys,
      ...(zs ? { zs } : {}),
      ...(result.featureCodes ? { featureCodes: result.featureCodes } : {}),
      ...(result.featureCatalog ? { featureCatalog: result.featureCatalog } : {}),
    },
  };
}

function handleCountFeatureCodes(
  request: Extract<PointsWorkerRequest, { type: 'countFeatureCodes' }>
): PointsWorkerResponse {
  const { codes, countValues } = countFeatureCodesFromArray(request.sourceFeatureCodes);
  return {
    ok: true,
    result: {
      kind: 'featureCounts',
      codes,
      counts: countValues,
    },
  };
}

async function scanTablesForFeatureCounts(
  parquetModule: ParquetModule,
  request: Extract<PointsWorkerRequest, { type: 'scanParquetFeatureCounts' }>
): Promise<Map<number, number>> {
  const columns = [
    request.featureKey,
    ...(request.featureCodeColumnName ? [request.featureCodeColumnName] : []),
  ];
  const counts = new Map<number, number>();

  if (request.rowGroups?.length && parquetModule.readParquetRowGroup) {
    for (const chunk of request.rowGroups) {
      const table = tableFromIPC(
        parquetModule.readParquetRowGroup(
          chunk.schemaBytes,
          chunk.rowGroupBytes,
          chunk.rowGroupIndex,
          { columns }
        ).intoIPCStream()
      );
      scanTableFeatureCounts(table, request.featureKey, request.featureCodeColumnName, counts);
    }
    return counts;
  }

  for (const part of request.parts ?? []) {
    const table = tableFromIPC(parquetModule.readParquet(part, { columns }).intoIPCStream());
    scanTableFeatureCounts(table, request.featureKey, request.featureCodeColumnName, counts);
  }
  return counts;
}

async function handleScanParquetFeatureCounts(
  request: Extract<PointsWorkerRequest, { type: 'scanParquetFeatureCounts' }>
): Promise<PointsWorkerResponse> {
  const parquetModule = await getParquetModule();
  const counts = await scanTablesForFeatureCounts(parquetModule, request);
  const { codes, countValues } = histogramToSortedArrays(counts);
  return {
    ok: true,
    result: {
      kind: 'featureCounts',
      codes,
      counts: countValues,
    },
  };
}

async function scanPayloadByFeatureCodes(
  parquetModule: ParquetModule,
  request: Extract<PointsWorkerRequest, { type: 'scanParquetByFeatureCodes' }>,
  input: {
    matchedRows: number;
    xs: number[];
    ys: number[];
    zs: number[];
    scannedRows: number;
  }
): Promise<{ matchedRows: number; scannedRows: number }> {
  const hasZ = request.axisNames.includes('z');
  const columns = [
    ...request.axisNames,
    request.featureKey,
    ...(request.featureCodeColumnName ? [request.featureCodeColumnName] : []),
  ];

  if (request.rowGroups?.length && parquetModule.readParquetRowGroup) {
    for (const chunk of request.rowGroups) {
      if (input.matchedRows >= request.memoryCap) {
        break;
      }
      const table = tableFromIPC(
        parquetModule.readParquetRowGroup(
          chunk.schemaBytes,
          chunk.rowGroupBytes,
          chunk.rowGroupIndex,
          { columns }
        ).intoIPCStream()
      );
      input.scannedRows += table.numRows;
      input.matchedRows = scanTableByFeatureCodes({
        table,
        axisNames: request.axisNames,
        featureKey: request.featureKey,
        featureCodeColumnName: request.featureCodeColumnName,
        featureCodes: request.featureCodes,
        memoryCap: request.memoryCap,
        matchedRows: input.matchedRows,
        xs: input.xs,
        ys: input.ys,
        zs: input.zs,
      });
    }
    return { matchedRows: input.matchedRows, scannedRows: input.scannedRows };
  }

  for (const part of request.parts ?? []) {
    if (input.matchedRows >= request.memoryCap) {
      break;
    }
    const table = tableFromIPC(parquetModule.readParquet(part, { columns }).intoIPCStream());
    input.scannedRows += table.numRows;
    input.matchedRows = scanTableByFeatureCodes({
      table,
      axisNames: request.axisNames,
      featureKey: request.featureKey,
      featureCodeColumnName: request.featureCodeColumnName,
      featureCodes: request.featureCodes,
      memoryCap: request.memoryCap,
      matchedRows: input.matchedRows,
      xs: input.xs,
      ys: input.ys,
      zs: input.zs,
    });
  }
  return { matchedRows: input.matchedRows, scannedRows: input.scannedRows };
}

async function handleScanParquetByFeatureCodes(
  request: Extract<PointsWorkerRequest, { type: 'scanParquetByFeatureCodes' }>
): Promise<PointsWorkerResponse> {
  const parquetModule = await getParquetModule();
  const hasZ = request.axisNames.includes('z');
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const { matchedRows, scannedRows } = await scanPayloadByFeatureCodes(parquetModule, request, {
    matchedRows: 0,
    xs,
    ys,
    zs,
    scannedRows: 0,
  });
  const outX = Float32Array.from(xs);
  const outY = Float32Array.from(ys);
  const outZ = hasZ ? Float32Array.from(zs) : undefined;
  const shape = outZ ? [3, outX.length] : [2, outX.length];
  return {
    ok: true,
    result: {
      kind: 'columnarScan',
      shape,
      xs: outX,
      ys: outY,
      ...(outZ ? { zs: outZ } : {}),
      matchedRows,
      scannedRows,
    },
  };
}

async function handleScanMortonRowGroupsInBounds(
  request: Extract<PointsWorkerRequest, { type: 'scanMortonRowGroupsInBounds' }>
): Promise<PointsWorkerResponse> {
  const parquetModule = await getParquetModule();
  if (!parquetModule.readParquetRowGroup) {
    return { ok: false, error: 'parquet-wasm readParquetRowGroup is unavailable in points worker' };
  }
  const hasZ = request.axisNames.includes('z');
  const columns = [
    'x',
    'y',
    ...(hasZ ? ['z'] : []),
    request.mortonCodeColumnName,
    ...(request.featureCodeColumnName ? [request.featureCodeColumnName] : []),
  ];
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (const chunk of request.rowGroups) {
    const table = tableFromIPC(
      parquetModule.readParquetRowGroup(
        chunk.schemaBytes,
        chunk.rowGroupBytes,
        chunk.rowGroupIndex,
        { columns }
      ).intoIPCStream()
    );
    scanMortonTableInBounds({
      table,
      rowGroupIndex: chunk.globalRowGroupIndex ?? chunk.rowGroupIndex,
      bounds: request.bounds,
      axisNames: request.axisNames,
      mortonCodeColumnName: request.mortonCodeColumnName,
      featureCodeColumnName: request.featureCodeColumnName,
      featureCodes: request.featureCodes,
      xs,
      ys,
      zs,
    });
  }
  const outX = Float32Array.from(xs);
  const outY = Float32Array.from(ys);
  const outZ = hasZ ? Float32Array.from(zs) : undefined;
  const shape = outZ ? [3, outX.length] : [2, outX.length];
  return {
    ok: true,
    result: {
      kind: 'columnar',
      shape,
      xs: outX,
      ys: outY,
      ...(outZ ? { zs: outZ } : {}),
    },
  };
}

function handleBuildFeatureCatalog(
  request: Extract<PointsWorkerRequest, { type: 'buildFeatureCatalog' }>
): PointsWorkerResponse {
  const table = tableFromIPC(request.tableIpc);
  const nameColumn = table.getChild(request.featureKey);
  if (!nameColumn) {
    return { ok: false, error: `Feature column "${request.featureKey}" not found` };
  }
  const codeColumnName = table.schema.fields
    .map((field) => field.name)
    .find((name): name is string => typeof name === 'string' && name.endsWith('_codes'));
  const codeColumn = codeColumnName ? table.getChild(codeColumnName) : null;
  const mortonColumn = table.getChild('morton_code_2d');
  const catalog = buildFeatureCatalogFromColumns(
    request.featureKey,
    nameColumn,
    codeColumn,
    mortonColumn,
    table.numRows
  );
  return { ok: true, result: { kind: 'catalog', catalog } };
}

async function handleRequest(request: PointsWorkerRequest): Promise<PointsWorkerResponse> {
  switch (request.type) {
    case 'filterColumnarByFeatureCodes':
      return handleFilterColumnar(request);
    case 'decodeParquetParts':
      return handleDecodeParquet(request);
    case 'buildFeatureCatalog':
      return handleBuildFeatureCatalog(request);
    case 'decodeParquetRowFeatureCodes':
      return handleDecodeParquetRowFeatureCodes(request);
    case 'scanParquetFeatureCatalog':
      return handleScanParquetFeatureCatalog(request);
    case 'decodeParquetGeometryCapped':
      return handleDecodeParquetGeometryCapped(request);
    case 'decodeGeometryWithFeatures':
      return handleDecodeGeometryWithFeatures(request);
    case 'countFeatureCodes':
      return handleCountFeatureCodes(request);
    case 'scanParquetFeatureCounts':
      return handleScanParquetFeatureCounts(request);
    case 'scanParquetByFeatureCodes':
      return handleScanParquetByFeatureCodes(request);
    case 'scanMortonRowGroupsInBounds':
      return handleScanMortonRowGroupsInBounds(request);
    default: {
      const _exhaustive: never = request;
      return { ok: false, error: `Unknown request type: ${String(_exhaustive)}` };
    }
  }
}

self.onmessage = (event: MessageEvent<PointsWorkerMessage>) => {
  const message = event.data;
  if (message.direction !== 'request') {
    return;
  }
  void handleRequest(message.request)
    .then((response) => {
      const reply: PointsWorkerMessage = { id: message.id, direction: 'response', response };
      const transferables: Transferable[] = [];
      if (response.ok) {
        if (response.result.kind === 'columnar' || response.result.kind === 'columnarScan') {
          transferables.push(response.result.xs.buffer, response.result.ys.buffer);
          if (response.result.zs) {
            transferables.push(response.result.zs.buffer);
          }
          if (response.result.kind === 'columnar' && response.result.featureCodes) {
            transferables.push(response.result.featureCodes.buffer);
          }
        } else if (response.result.kind === 'geometryWithFeatures') {
          transferables.push(response.result.xs.buffer, response.result.ys.buffer);
          if (response.result.zs) {
            transferables.push(response.result.zs.buffer);
          }
          if (response.result.featureCodes) {
            transferables.push(response.result.featureCodes.buffer);
          }
        } else if (response.result.kind === 'parquetTable') {
          transferables.push(response.result.tableIpc.buffer);
        } else if (response.result.kind === 'rowFeatureCodes') {
          transferables.push(response.result.codes.buffer);
        } else if (response.result.kind === 'featureCounts') {
          transferables.push(response.result.codes.buffer, response.result.counts.buffer);
        }
      }
      self.postMessage(reply, transferables);
    })
    .catch((error: unknown) => {
      const reply: PointsWorkerMessage = {
        id: message.id,
        direction: 'response',
        response: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
      self.postMessage(reply);
    });
};

export {};
