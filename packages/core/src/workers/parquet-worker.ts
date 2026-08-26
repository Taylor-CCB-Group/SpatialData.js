import { tableFromIPC, tableToIPC } from 'apache-arrow';
import {
  getParquetModule,
  type ParquetModule,
  type ParquetWasmFile,
} from '../parquetWasmLoader.js';
import { buildFeatureCatalogFromColumns } from '../pointsFeatures.js';
import { filterColumnarByFeatureCodes } from '../pointsTiling.js';
import { decodeShapesGeometryFlat } from '../shapesGeometryDecode.js';
import { tessellateFlatPolygons } from '../shapesPolygonTessellate.js';
import type {
  ParquetWorkerMessage,
  ParquetWorkerRequest,
  ParquetWorkerResponse,
  ParquetWorkerStreamChunk,
} from './parquetWorkerProtocol.js';
import { transferablesForStreamChunk } from './parquetWorkerProtocol.js';
import {
  appendFeatureCodesFromColumn,
  countFeatureCodesFromArray,
  decodeGeometryWithFeaturesFromPayload,
  decodeParquetPartsToTable,
  decodeParquetPayloadToTable,
  extractGeometryColumnar,
  extractRowFeatureCodesFromTable,
  Float32PointBuffer,
  histogramToSortedArrays,
  Int32PointBuffer,
  scanFeatureCatalogFromPayload,
  scanMortonTableInBounds,
  scanTableByFeatureCodes,
  scanTableFeatureCounts,
} from './pointsScan.js';

function toFloat32Array(values: ArrayLike<number>): Float32Array {
  if (values instanceof Float32Array) {
    return values;
  }
  return Float32Array.from(values);
}

function toInt32Array(values: ArrayLike<number>): Int32Array {
  if (values instanceof Int32Array) {
    return values;
  }
  return Int32Array.from(values);
}

function handleFilterColumnar(
  request: Extract<ParquetWorkerRequest, { type: 'filterColumnarByFeatureCodes' }>
) {
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
  const featureCodes = filtered.featureCodes ? toInt32Array(filtered.featureCodes) : undefined;
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
      ...(featureCodes ? { featureCodes } : {}),
    },
  };
}

async function handleDecodeParquet(
  request: Extract<ParquetWorkerRequest, { type: 'decodeParquetParts' }>
): Promise<ParquetWorkerResponse> {
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
  request: Extract<ParquetWorkerRequest, { type: 'decodeParquetRowFeatureCodes' }>
): Promise<ParquetWorkerResponse> {
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
  request: Extract<ParquetWorkerRequest, { type: 'scanParquetFeatureCatalog' }>
): Promise<ParquetWorkerResponse> {
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
  request: Extract<ParquetWorkerRequest, { type: 'decodeParquetGeometryCapped' }>
): Promise<ParquetWorkerResponse> {
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
  request: Extract<ParquetWorkerRequest, { type: 'decodeGeometryWithFeatures' }>
): Promise<ParquetWorkerResponse> {
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
  request: Extract<ParquetWorkerRequest, { type: 'countFeatureCodes' }>
): ParquetWorkerResponse {
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
  request: Extract<ParquetWorkerRequest, { type: 'scanParquetFeatureCounts' }>
): Promise<Map<number, number>> {
  const columns = [
    request.featureKey,
    ...(request.featureCodeColumnName ? [request.featureCodeColumnName] : []),
  ];
  const counts = new Map<number, number>();

  if (request.rowGroups?.length && parquetModule.readParquetRowGroup) {
    for (const chunk of request.rowGroups) {
      const table = tableFromIPC(
        parquetModule
          .readParquetRowGroup(chunk.schemaBytes, chunk.rowGroupBytes, chunk.rowGroupIndex, {
            columns,
          })
          .intoIPCStream()
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
  request: Extract<ParquetWorkerRequest, { type: 'scanParquetFeatureCounts' }>
): Promise<ParquetWorkerResponse> {
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

/** Cached per URL: `fromUrl` reads the footer, and one scan issues several
 * requests against the same file as it walks row-group windows. */
const streamFilesByUrl = new Map<string, Promise<ParquetWasmFile>>();

/**
 * Stream variant of the feature scan, running IN THE WORKER.
 *
 * The byte-oriented path has the caller range-read whole row groups — every
 * column — because parquet-wasm cannot fetch individual column chunks. This asks
 * `ParquetFile.stream` for just the projected columns, so the projection reaches
 * the network, and keeps the decode off the main thread (which the URL-streaming
 * scan could not do while `supportsParquetStreaming` required `window`).
 *
 * One request covers a row-group window chosen by the caller, so progress stays
 * granular without the protocol needing streamed responses.
 */
async function scanStreamByFeatureCodes(
  request: Extract<ParquetWorkerRequest, { type: 'scanParquetByFeatureCodes' }>,
  input: {
    matchedRows: number;
    xs: Float32PointBuffer;
    ys: Float32PointBuffer;
    zs: Float32PointBuffer;
    codes: Int32PointBuffer;
    scannedRows: number;
  }
): Promise<{ matchedRows: number; scannedRows: number }> {
  const url = request.streamUrl as string;
  const { ParquetFile } = await getParquetModule();
  if (!ParquetFile) {
    throw new Error('ParquetFile.stream is unavailable in the parquet worker');
  }
  let filePromise = streamFilesByUrl.get(url);
  if (!filePromise) {
    filePromise = ParquetFile.fromUrl(url);
    // Cache the attempt, not the failure. Without this a single transient
    // footer read poisons the URL for the life of the worker: every later scan
    // awaits the same rejected promise and can never retry.
    filePromise.catch(() => {
      if (streamFilesByUrl.get(url) === filePromise) {
        streamFilesByUrl.delete(url);
      }
    });
    streamFilesByUrl.set(url, filePromise);
  }
  const file = await filePromise;
  const featureCodeByName = request.featureCodeEntries
    ? new Map(request.featureCodeEntries.map((entry) => [entry.name, entry.code]))
    : undefined;

  const stream = await file.stream({
    ...(request.streamColumns?.length ? { columns: request.streamColumns } : {}),
    ...(request.streamRowGroups?.length ? { rowGroups: request.streamRowGroups } : {}),
    batchSize: 65_536,
  });
  const reader = stream.getReader();
  try {
    for (;;) {
      if (input.matchedRows >= request.memoryCap) {
        break;
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const table = tableFromIPC(value.intoIPCStream());
      input.scannedRows += table.numRows;
      input.matchedRows = scanTableByFeatureCodes({
        table,
        axisNames: request.axisNames,
        featureKey: request.featureKey,
        ...(request.featureCodeColumnName
          ? { featureCodeColumnName: request.featureCodeColumnName }
          : {}),
        featureCodes: request.featureCodes,
        memoryCap: request.memoryCap,
        matchedRows: input.matchedRows,
        xs: input.xs,
        ys: input.ys,
        zs: input.zs,
        codes: input.codes,
        ...(featureCodeByName ? { featureCodeByName } : {}),
      });
    }
  } finally {
    reader.releaseLock();
  }
  return { matchedRows: input.matchedRows, scannedRows: input.scannedRows };
}

async function scanPayloadByFeatureCodes(
  parquetModule: ParquetModule,
  request: Extract<ParquetWorkerRequest, { type: 'scanParquetByFeatureCodes' }>,
  input: {
    matchedRows: number;
    xs: Float32PointBuffer;
    ys: Float32PointBuffer;
    zs: Float32PointBuffer;
    codes: Int32PointBuffer;
    scannedRows: number;
  }
): Promise<{ matchedRows: number; scannedRows: number }> {
  const _hasZ = request.axisNames.includes('z');
  if (request.streamUrl) {
    return scanStreamByFeatureCodes(request, input);
  }
  const columns = [
    ...request.axisNames,
    request.featureKey,
    ...(request.featureCodeColumnName ? [request.featureCodeColumnName] : []),
  ];
  const featureCodeByName = request.featureCodeEntries
    ? new Map(request.featureCodeEntries.map((entry) => [entry.name, entry.code]))
    : undefined;

  if (request.rowGroups?.length && parquetModule.readParquetRowGroup) {
    for (const chunk of request.rowGroups) {
      if (input.matchedRows >= request.memoryCap) {
        break;
      }
      const table = tableFromIPC(
        parquetModule
          .readParquetRowGroup(chunk.schemaBytes, chunk.rowGroupBytes, chunk.rowGroupIndex, {
            columns,
          })
          .intoIPCStream()
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
        codes: input.codes,
        featureCodeByName,
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
      codes: input.codes,
      featureCodeByName,
    });
  }
  return { matchedRows: input.matchedRows, scannedRows: input.scannedRows };
}

async function handleScanParquetByFeatureCodes(
  request: Extract<ParquetWorkerRequest, { type: 'scanParquetByFeatureCodes' }>
): Promise<ParquetWorkerResponse> {
  const parquetModule = await getParquetModule();
  const hasZ = request.axisNames.includes('z');
  // Typed accumulators, reserved per chunk against an exact upper bound inside the
  // scan (see `TypedPointBuffer`): no boxing, no growth copies, and no final
  // `Float32Array.from` of a `number[]` holding both representations at once.
  const xs = new Float32PointBuffer();
  const ys = new Float32PointBuffer();
  const zs = new Float32PointBuffer();
  const codes = new Int32PointBuffer();
  const { matchedRows, scannedRows } = await scanPayloadByFeatureCodes(parquetModule, request, {
    matchedRows: 0,
    xs,
    ys,
    zs,
    codes,
    scannedRows: 0,
  });
  const outX = xs.toArray();
  const outY = ys.toArray();
  const outZ = hasZ ? zs.toArray() : undefined;
  const outCodes = codes.length > 0 ? codes.toArray() : undefined;
  const shape = outZ ? [3, outX.length] : [2, outX.length];
  return {
    ok: true,
    result: {
      kind: 'columnarScan',
      shape,
      xs: outX,
      ys: outY,
      ...(outZ ? { zs: outZ } : {}),
      ...(outCodes ? { featureCodes: outCodes } : {}),
      matchedRows,
      scannedRows,
    },
  };
}

async function handleScanMortonRowGroupsInBounds(
  request: Extract<ParquetWorkerRequest, { type: 'scanMortonRowGroupsInBounds' }>
): Promise<ParquetWorkerResponse> {
  const parquetModule = await getParquetModule();
  if (!parquetModule.readParquetRowGroup) {
    return {
      ok: false,
      error: 'parquet-wasm readParquetRowGroup is unavailable in parquet worker',
    };
  }
  const hasZ = request.axisNames.includes('z');
  const columns = [
    'x',
    'y',
    ...(hasZ ? ['z'] : []),
    request.mortonCodeColumnName,
    ...(request.featureCodeColumnName ? [request.featureCodeColumnName] : []),
  ];
  const xs = new Float32PointBuffer();
  const ys = new Float32PointBuffer();
  const zs = new Float32PointBuffer();
  // Collect per-point codes whenever the element has a code column — including when
  // no filter is active, which is precisely the "all features" view that colouring
  // needs. Gating this on `request.featureCodes` (the filter) would leave the
  // default view flat.
  const codes = request.featureCodeColumnName ? new Int32PointBuffer() : undefined;
  for (const chunk of request.rowGroups) {
    const table = tableFromIPC(
      parquetModule
        .readParquetRowGroup(chunk.schemaBytes, chunk.rowGroupBytes, chunk.rowGroupIndex, {
          columns,
        })
        .intoIPCStream()
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
      ...(codes ? { codes } : {}),
    });
  }
  const outX = xs.toArray();
  const outY = ys.toArray();
  const outZ = hasZ ? zs.toArray() : undefined;
  const outCodes = codes?.toArray();
  const shape = outZ ? [3, outX.length] : [2, outX.length];
  return {
    ok: true,
    result: {
      kind: 'columnar',
      shape,
      xs: outX,
      ys: outY,
      ...(outZ ? { zs: outZ } : {}),
      // Short codes are unusable, not partially usable: the remaining points would
      // read code 0 — a VALID feature — and be confidently mis-coloured. Ship them
      // only when there is exactly one per point.
      ...(outCodes && outCodes.length === outX.length ? { featureCodes: outCodes } : {}),
    },
  };
}

function handleBuildFeatureCatalog(
  request: Extract<ParquetWorkerRequest, { type: 'buildFeatureCatalog' }>
): ParquetWorkerResponse {
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

async function handleDecodeShapesGeometry(
  request: Extract<ParquetWorkerRequest, { type: 'decodeShapesGeometry' }>
): Promise<ParquetWorkerResponse> {
  const { readParquet } = await getParquetModule();
  // Project only the geometry column: the feature index / row-index columns are
  // cheap and stay on the main thread; the WKB parse is the expensive part.
  const table = await decodeParquetPartsToTable(readParquet, request.parts, [
    request.geometryColumnName,
  ]);
  const geometry = decodeShapesGeometryFlat(
    table,
    request.geometryColumnName,
    request.geometryKind
  );
  if (geometry.kind === 'polygon') {
    // Tessellate here, off the main thread, so the render topology transfers back
    // ready to upload — no ~seconds-long main-thread tessellation on first paint.
    const tessellation = tessellateFlatPolygons(geometry.positions, geometry.startIndices);
    return {
      ok: true,
      result: {
        kind: 'shapesGeometryPolygon',
        positions: geometry.positions,
        startIndices: geometry.startIndices,
        featureCount: geometry.featureCount,
        tessellation,
      },
    };
  }
  return {
    ok: true,
    result: {
      kind: 'shapesGeometryPoint',
      xs: geometry.xs,
      ys: geometry.ys,
      featureCount: geometry.featureCount,
    },
  };
}

/**
 * Cancellation flags for in-flight `streamGeometryWithFeatures` requests, keyed by
 * the request id the stream is running under. A `cancelParquetStream` sets the flag
 * and the stream loop stops before its next batch; without it a superseded preload
 * keeps range-fetching a whole element nobody will read.
 */
const activeStreams = new Map<number, { cancelled: boolean }>();

type StreamEmitter = (chunk: ParquetWorkerStreamChunk) => void;

/** Copy one axis column's first `rows` values into a fresh transferable buffer. */
function axisBatchValues(values: ArrayLike<number>, rows: number): Float32Array {
  const out = new Float32Array(rows);
  if (ArrayBuffer.isView(values)) {
    // Typed source: one `set` (with the f64 -> f32 narrowing when needed) rather
    // than a per-row JS loop.
    out.set((values as unknown as Float32Array).subarray(0, rows));
    return out;
  }
  for (let row = 0; row < rows; row += 1) {
    out[row] = values[row];
  }
  return out;
}

/**
 * The progressive geometry+colour preload, run end to end in the worker: range-fetch
 * each part, decode batch by batch, and post every batch back as it lands.
 *
 * This is the same decode `VPointsSource.streamPointsWithFeaturesByUrl` performs on
 * the main thread, moved here. It has to stay a decode-and-emit loop rather than a
 * decode-then-return one, because the progressive paint is the reason that path is
 * taken at all — a single whole-payload response would swap a blocked tab for a
 * blank one.
 *
 * The accumulator stays on the MAIN thread (it owns the buffers the renderer reads),
 * so each batch carries only its own rows plus deltas: the catalog entries first seen
 * in this batch, and this batch's per-feature tallies. `codeToName` / `nameToCode`
 * persist across batches and across parts, so a gene coloured in batch 1 keeps its
 * code in batch 62 and the catalog always describes the codes actually written.
 */
async function handleStreamGeometryWithFeatures(
  request: Extract<ParquetWorkerRequest, { type: 'streamGeometryWithFeatures' }>,
  emit: StreamEmitter,
  isCancelled: () => boolean
): Promise<ParquetWorkerResponse> {
  const { ParquetFile } = await getParquetModule();
  if (!ParquetFile) {
    return { ok: false, error: 'parquet-wasm ParquetFile is unavailable in this worker' };
  }
  const { partUrls, axisNames, featureKey, maxRows, batchSize } = request;
  const axisCount = axisNames.length;
  const codeToName = new Map<number, string>();
  const nameToCode = new Map<string, number>();
  let emitted = 0;
  let sawFeatureColumn = true;

  for (const [partIndex, url] of partUrls.entries()) {
    if (emitted >= maxRows || isCancelled()) {
      break;
    }
    const file = await ParquetFile.fromUrl(url);
    const stream = await file.stream({
      columns: [...axisNames, featureKey],
      batchSize,
    });
    const reader = stream.getReader();
    try {
      for (;;) {
        if (emitted >= maxRows || isCancelled()) {
          break;
        }
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const table = tableFromIPC(value.intoIPCStream());
        const rows = Math.min(table.numRows, maxRows - emitted);
        if (rows <= 0) {
          continue;
        }
        const featureColumn = table.getChild(featureKey);
        if (!featureColumn) {
          // The projection came back without the feature column, so nothing after
          // this point can be coloured. End the stream rather than emit flat rows
          // the caller would take for coloured ones.
          sawFeatureColumn = false;
          break;
        }
        const axes: Float32Array[] = [];
        for (let axis = 0; axis < axisCount; axis += 1) {
          const column = table.getChild(axisNames[axis]);
          axes.push(
            column
              ? axisBatchValues(column.toArray() as ArrayLike<number>, rows)
              : new Float32Array(rows)
          );
        }
        const knownBefore = nameToCode.size;
        const featureCodes = new Int32Array(rows);
        const batchCounts = new Map<number, number>();
        appendFeatureCodesFromColumn(
          featureColumn,
          rows,
          codeToName,
          nameToCode,
          featureCodes,
          batchCounts,
          0
        );
        // Codes are handed out as `nameToCode.size`, so everything at or above the
        // pre-batch size is new — no diffing of the whole catalog per batch.
        const newFeatures: Array<{ code: number; name: string }> = [];
        for (let code = knownBefore; code < nameToCode.size; code += 1) {
          const name = codeToName.get(code);
          if (name !== undefined) {
            newFeatures.push({ code, name });
          }
        }
        const tallyCodes = new Int32Array(batchCounts.size);
        const tallyCounts = new Uint32Array(batchCounts.size);
        let tallyIndex = 0;
        for (const [code, count] of batchCounts) {
          tallyCodes[tallyIndex] = code;
          tallyCounts[tallyIndex] = count;
          tallyIndex += 1;
        }
        emitted += rows;
        if (isCancelled()) {
          // Cancelled while this batch decoded: the caller has already settled and
          // stopped listening, so posting would only be dropped on arrival.
          break;
        }
        emit({
          kind: 'geometryWithFeaturesBatch',
          partIndex,
          partCount: partUrls.length,
          rows,
          axes,
          featureCodes,
          newFeatures,
          tallyCodes,
          tallyCounts,
        });
      }
    } finally {
      // Covers both endings: on a stream that ran to completion this resolves and
      // releases the lock, and on an early break it also stops the reader's
      // outstanding range requests.
      try {
        await reader.cancel();
      } catch {
        /* the stream is already gone */
      }
    }
    if (!sawFeatureColumn) {
      break;
    }
  }

  if (isCancelled()) {
    return { ok: true, result: { kind: 'streamCancelled' } };
  }
  return {
    ok: true,
    result: { kind: 'geometryWithFeaturesStreamEnd', rows: emitted, sawFeatureColumn },
  };
}

function handleCancelParquetStream(
  request: Extract<ParquetWorkerRequest, { type: 'cancelParquetStream' }>
): ParquetWorkerResponse {
  const target = activeStreams.get(request.streamRequestId);
  if (target) {
    target.cancelled = true;
  }
  return { ok: true, result: { kind: 'streamCancelled' } };
}

async function handleRequest(
  request: ParquetWorkerRequest,
  context: { emit: StreamEmitter; isCancelled: () => boolean }
): Promise<ParquetWorkerResponse> {
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
    case 'decodeShapesGeometry':
      return handleDecodeShapesGeometry(request);
    case 'streamGeometryWithFeatures':
      return handleStreamGeometryWithFeatures(request, context.emit, context.isCancelled);
    case 'cancelParquetStream':
      return handleCancelParquetStream(request);
    default: {
      const _exhaustive: never = request;
      return { ok: false, error: `Unknown request type: ${String(_exhaustive)}` };
    }
  }
}

self.onmessage = (event: MessageEvent<ParquetWorkerMessage>) => {
  const message = event.data;
  if (message.direction !== 'request') {
    return;
  }
  // Only streaming requests can be cancelled, so only they get a registry entry —
  // an entry per request would be a leak on the ~thousands of ordinary decodes a
  // session runs.
  const isStreaming = message.request.type === 'streamGeometryWithFeatures';
  const state = { cancelled: false };
  if (isStreaming) {
    activeStreams.set(message.id, state);
  }
  const emit: StreamEmitter = (chunk) => {
    const interim: ParquetWorkerMessage = { id: message.id, direction: 'stream', chunk };
    self.postMessage(interim, transferablesForStreamChunk(chunk));
  };
  void handleRequest(message.request, { emit, isCancelled: () => state.cancelled })
    .then((response) => {
      const reply: ParquetWorkerMessage = { id: message.id, direction: 'response', response };
      const transferables: Transferable[] = [];
      if (response.ok) {
        if (response.result.kind === 'columnar' || response.result.kind === 'columnarScan') {
          transferables.push(response.result.xs.buffer, response.result.ys.buffer);
          if (response.result.zs) {
            transferables.push(response.result.zs.buffer);
          }
          if (response.result.featureCodes) {
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
        } else if (response.result.kind === 'shapesGeometryPolygon') {
          transferables.push(response.result.positions.buffer, response.result.startIndices.buffer);
          const tess = response.result.tessellation;
          if (tess) {
            transferables.push(
              tess.ringPositions.buffer,
              tess.triangleData.buffer,
              tess.featureScale.buffer
            );
          }
        } else if (response.result.kind === 'shapesGeometryPoint') {
          transferables.push(response.result.xs.buffer, response.result.ys.buffer);
        }
      }
      self.postMessage(reply, transferables);
    })
    .catch((error: unknown) => {
      const reply: ParquetWorkerMessage = {
        id: message.id,
        direction: 'response',
        response: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
      self.postMessage(reply);
    })
    .finally(() => {
      if (isStreaming) {
        activeStreams.delete(message.id);
      }
    });
};
