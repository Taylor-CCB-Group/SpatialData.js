import { tableFromIPC, tableToIPC } from 'apache-arrow';
import {
  buildFeatureCatalogFromColumns,
} from '../pointsFeatures.js';
import {
  filterColumnarByFeatureCodes,
} from '../pointsTiling.js';
import type { PointsWorkerMessage, PointsWorkerRequest, PointsWorkerResponse } from './pointsWorkerProtocol.js';
import {
  countFeatureCodesFromArray,
  decodeParquetPartsToTable,
  decodeParquetRowGroupsToTable,
  extractRowFeatureCodesFromTable,
  scanTableByFeatureCodes,
  scanTableFeatureCounts,
  histogramToSortedArrays,
} from './pointsWorkerScan.js';

type ParquetWasmTableLike = { intoIPCStream(): Uint8Array };
type ParquetModule = {
  readParquet: (bytes: Uint8Array, options?: { columns?: string[] }) => ParquetWasmTableLike;
  readParquetRowGroup?: (
    schemaBytes: Uint8Array,
    rowGroupBytes: Uint8Array,
    rowGroupIndex: number,
    options?: { columns?: string[] }
  ) => ParquetWasmTableLike;
};

let parquetModulePromise: Promise<ParquetModule> | undefined;

async function getParquetModule(): Promise<ParquetModule> {
  if (!parquetModulePromise) {
    parquetModulePromise = (async () => {
      const module = await import('parquet-wasm');
      const maybeInit = (module as { default?: unknown }).default;
      if (typeof maybeInit === 'function') {
        await maybeInit();
      }
      const readParquet = (module as ParquetModule).readParquet;
      if (typeof readParquet !== 'function') {
        throw new Error('parquet-wasm readParquet is unavailable in points worker');
      }
      const readParquetRowGroup = (module as ParquetModule).readParquetRowGroup;
      return {
        readParquet,
        readParquetRowGroup:
          typeof readParquetRowGroup === 'function' ? readParquetRowGroup : undefined,
      };
    })();
  }
  return parquetModulePromise;
}

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
  let table;
  if (request.rowGroups?.length) {
    if (!parquetModule.readParquetRowGroup) {
      return { ok: false, error: 'parquet-wasm readParquetRowGroup is unavailable in points worker' };
    }
    table = await decodeParquetRowGroupsToTable(
      parquetModule.readParquetRowGroup,
      request.rowGroups,
      request.columns,
      request.maxRows
    );
  } else if (request.parts?.length) {
    table = await decodeParquetPartsToTable(
      parquetModule.readParquet,
      request.parts,
      request.columns,
      request.maxRows
    );
  } else {
    return { ok: false, error: 'decodeParquetRowFeatureCodes requires parts or rowGroups' };
  }
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

async function handleScanParquetFeatureCounts(
  request: Extract<PointsWorkerRequest, { type: 'scanParquetFeatureCounts' }>
): Promise<PointsWorkerResponse> {
  const { readParquet } = await getParquetModule();
  const columns = [
    request.featureKey,
    ...(request.featureCodeColumnName ? [request.featureCodeColumnName] : []),
  ];
  const counts = new Map<number, number>();
  for (const part of request.parts) {
    const table = tableFromIPC(readParquet(part, { columns }).intoIPCStream());
    scanTableFeatureCounts(table, request.featureKey, request.featureCodeColumnName, counts);
  }
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

async function handleScanParquetByFeatureCodes(
  request: Extract<PointsWorkerRequest, { type: 'scanParquetByFeatureCodes' }>
): Promise<PointsWorkerResponse> {
  const { readParquet } = await getParquetModule();
  const hasZ = request.axisNames.includes('z');
  const columns = [
    ...request.axisNames,
    request.featureKey,
    ...(request.featureCodeColumnName ? [request.featureCodeColumnName] : []),
  ];
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  let matchedRows = 0;
  let scannedRows = 0;
  for (const part of request.parts) {
    if (matchedRows >= request.memoryCap) {
      break;
    }
    const table = tableFromIPC(readParquet(part, { columns }).intoIPCStream());
    scannedRows += table.numRows;
    matchedRows = scanTableByFeatureCodes({
      table,
      axisNames: request.axisNames,
      featureKey: request.featureKey,
      featureCodeColumnName: request.featureCodeColumnName,
      featureCodes: request.featureCodes,
      memoryCap: request.memoryCap,
      matchedRows,
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
    case 'countFeatureCodes':
      return handleCountFeatureCodes(request);
    case 'scanParquetFeatureCounts':
      return handleScanParquetFeatureCounts(request);
    case 'scanParquetByFeatureCodes':
      return handleScanParquetByFeatureCodes(request);
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
        if (response.result.kind === 'columnar') {
          transferables.push(response.result.xs.buffer, response.result.ys.buffer);
          if (response.result.zs) {
            transferables.push(response.result.zs.buffer);
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
