import { tableFromIPC, tableToIPC, type Table } from 'apache-arrow';
import {
  buildFeatureCatalogFromColumns,
} from '../pointsFeatures.js';
import {
  filterColumnarByFeatureCodes,
} from '../pointsTiling.js';
import type { PointsWorkerMessage, PointsWorkerRequest, PointsWorkerResponse } from './pointsWorkerProtocol.js';

type ParquetWasmTableLike = { intoIPCStream(): Uint8Array };
type ParquetModule = {
  readParquet: (bytes: Uint8Array, options?: { columns?: string[] }) => ParquetWasmTableLike;
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
      return { readParquet };
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

async function concatParquetTables(tables: Table[]): Promise<Table> {
  if (tables.length === 0) {
    throw new Error('No parquet tables to concatenate');
  }
  return tables.slice(1).reduce((merged, part) => merged.concat(part), tables[0]);
}

async function handleDecodeParquet(
  request: Extract<PointsWorkerRequest, { type: 'decodeParquetParts' }>
): Promise<PointsWorkerResponse> {
  const { readParquet } = await getParquetModule();
  const tables: Table[] = [];
  let accumulated = 0;
  for (const part of request.parts) {
    const table = tableFromIPC(readParquet(part, { columns: request.columns }).intoIPCStream());
    if (request.maxRows === undefined) {
      tables.push(table);
      continue;
    }
    const remaining = request.maxRows - accumulated;
    if (table.numRows <= remaining) {
      tables.push(table);
      accumulated += table.numRows;
    } else {
      tables.push(table.slice(0, remaining));
      break;
    }
    if (accumulated >= request.maxRows) {
      break;
    }
  }
  const merged = await concatParquetTables(tables);
  return {
    ok: true,
    result: {
      kind: 'parquetTable',
      tableIpc: tableToIPC(merged),
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
