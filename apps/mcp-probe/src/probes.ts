/**
 * Capability probes for a sandboxed MCP App iframe. Each answers one question
 * that decides whether part of SpatialData.js can run in the tile, and each is
 * independent so one hard failure does not mask the rest.
 */

export type ProbeRecord = { [key: string]: unknown };

/** Smallest valid WebAssembly module: magic + version. */
const EMPTY_WASM = [0, 97, 115, 109, 1, 0, 0, 0];
const WORKER_TIMEOUT_MS = 3000;

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

// ---------------------------------------------------------------- CSP -------

const violations: ProbeRecord[] = [];

/**
 * Blocked requests and workers fail opaquely (a bare TypeError, or an `error`
 * event with no message); the violation event is the only place that names the
 * directive. Install before anything else runs.
 */
export function watchCspViolations(): void {
  document.addEventListener('securitypolicyviolation', (e) => {
    violations.push({
      directive: e.effectiveDirective,
      blocked: e.blockedURI,
      disposition: e.disposition,
    });
  });
}

function cspReport(): ProbeRecord {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
  return {
    // Hosts may inject the policy as a meta tag; a header-delivered one is not readable.
    metaPolicy: meta?.getAttribute('content') ?? null,
    violations: [...violations],
  };
}

// ---------------------------------------------------------------- GPU -------

function webgl2Report(): ProbeRecord {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return { ok: false };
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    ok: true,
    renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'masked',
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
    maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
    // Float render targets are what group/FBO blending needs.
    EXT_color_buffer_float: gl.getExtension('EXT_color_buffer_float') !== null,
    OES_texture_float_linear: gl.getExtension('OES_texture_float_linear') !== null,
  };
}

async function webgpuReport(): Promise<ProbeRecord> {
  if (!('gpu' in navigator)) return { ok: false, reason: 'navigator.gpu missing' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'no adapter' };
    return {
      ok: true,
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
    };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

// ------------------------------------------------------------- workers ------

/**
 * `new Worker(blobUrl)` returns normally even when `worker-src` forbids it; the
 * refusal arrives later as an `error` event. So the only trustworthy answer is a
 * round trip.
 */
function pingWorker(source: string, options: WorkerOptions): Promise<ProbeRecord> {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const t0 = performance.now();
  return new Promise<ProbeRecord>((resolve) => {
    let worker: Worker;
    const finish = (result: ProbeRecord) => {
      clearTimeout(timer);
      worker?.terminate();
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), WORKER_TIMEOUT_MS);
    try {
      worker = new Worker(url, options);
    } catch (e) {
      finish({ ok: false, error: errorText(e) });
      return;
    }
    worker.onmessage = (e: MessageEvent<unknown>) =>
      finish(
        e.data === 'pong'
          ? { ok: true, ms: Math.round(performance.now() - t0) }
          : { ok: false, error: String(e.data) }
      );
    worker.onerror = (e) => finish({ ok: false, error: e.message || 'error event (no message)' });
    worker.postMessage('ping');
  });
}

const PONG = `self.onmessage = () => postMessage('pong');`;

// Our codec and parquet workers are module workers that compile WASM, so this
// combination is the one that matters; the others locate a failure.
const WASM_IN_WORKER = `
self.onmessage = async () => {
  try {
    await WebAssembly.compile(new Uint8Array([${EMPTY_WASM}]));
    postMessage('pong');
  } catch (e) {
    postMessage(String(e));
  }
};
export {};`;

async function workerReport(): Promise<ProbeRecord> {
  return {
    classicBlob: await pingWorker(PONG, {}),
    moduleBlob: await pingWorker(`${PONG}\nexport {};`, { type: 'module' }),
    wasmInModuleBlob: await pingWorker(WASM_IN_WORKER, { type: 'module' }),
  };
}

// ---------------------------------------------------------------- WASM ------

async function wasmReport(): Promise<ProbeRecord> {
  const bytes = new Uint8Array(EMPTY_WASM);
  const out: ProbeRecord = {};
  try {
    new WebAssembly.Module(bytes);
    out.syncCompile = true;
  } catch (e) {
    out.syncCompile = errorText(e);
  }
  try {
    await WebAssembly.compile(bytes);
    out.asyncCompile = true;
  } catch (e) {
    out.asyncCompile = errorText(e);
  }
  out.ok = out.syncCompile === true && out.asyncCompile === true;
  return out;
}

/** Bundlers load lazy chunks by importing blob or same-origin module URLs. */
async function blobImportReport(): Promise<ProbeRecord> {
  const url = URL.createObjectURL(
    new Blob(['export const answer = 42;'], { type: 'text/javascript' })
  );
  try {
    const mod: unknown = await import(/* @vite-ignore */ url);
    const ok = typeof mod === 'object' && mod !== null && 'answer' in mod && mod.answer === 42;
    return { ok };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --------------------------------------------------------------- store ------
// The request shapes SpatialData.js makes, as check_hosting.py makes them, but
// from inside the host: CORS, connect-src and local-network rules all apply here.

const PROBE_BYTES = 8;
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;

/** Read at most `limit` bytes, so a server that ignores Range cannot stream a whole file. */
async function readCapped(r: Response, limit: number): Promise<number> {
  const reader = r.body?.getReader();
  if (!reader) return 0;
  let total = 0;
  while (total <= limit) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.byteLength;
  }
  await reader.cancel();
  return total;
}

/** `needContentRange`: the reader learns the file size from it, so it must be exposed. */
async function rangeRead(
  url: string,
  range: string,
  needContentRange: boolean
): Promise<ProbeRecord> {
  try {
    const r = await fetch(url, { headers: { Range: range }, cache: 'no-store' });
    const contentRange = r.headers.get('content-range');
    const bytes = await readCapped(r, PROBE_BYTES);
    const match = contentRange ? CONTENT_RANGE.exec(contentRange) : null;
    let interval = false;
    if (match) {
      const [start, end, total] = [Number(match[1]), Number(match[2]), match[3]];
      interval = range.startsWith('bytes=-')
        ? total !== '*' && start === Number(total) - PROBE_BYTES && end === Number(total) - 1
        : start === 0 && end === PROBE_BYTES - 1;
    }
    return {
      // A hidden Content-Range is fine unless the reader needs it; a wrong one never is.
      ok:
        r.status === 206 &&
        bytes === PROBE_BYTES &&
        (interval || (!needContentRange && !contentRange)),
      status: r.status,
      // null when the server sends it but does not expose it.
      contentRange,
      bytes: bytes > PROBE_BYTES ? `>${PROBE_BYTES}` : bytes,
    };
  } catch (e) {
    // A TypeError here, with no CSP violation logged, is CORS: for a suffix
    // range usually the preflight, since only bounded ranges skip it.
    return { ok: false, error: errorText(e) };
  }
}

async function head(url: string): Promise<ProbeRecord> {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    const contentLength = r.headers.get('content-length');
    return {
      ok: r.ok && contentLength !== null,
      status: r.status,
      contentLength,
      contentType: r.headers.get('content-type'),
    };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

type Metadata = Record<
  string,
  { node_type?: string; shape?: number[]; codecs?: unknown[] } & Record<string, unknown>
>;

/**
 * Shards whose index sits at their end: zarrita sizes them with HEAD before reading the
 * index. Code-point order, as check_hosting.py uses.
 */
function shardPaths(metadata: Metadata): string[] {
  const paths: string[] = [];
  for (const [path, node] of Object.entries(metadata).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    if (node.node_type !== 'array' || !Array.isArray(node.codecs)) continue;
    const shard = node.codecs.find(
      (c): c is { configuration?: { index_location?: string } } =>
        typeof c === 'object' && c !== null && Reflect.get(c, 'name') === 'sharding_indexed'
    );
    if (!shard || shard.configuration?.index_location === 'start') continue;
    const encoding = Object(Reflect.get(node, 'chunk_key_encoding'));
    // The v2 encoding defaults to '.', the default encoding to '/'.
    const separator = String(
      Reflect.get(Object(encoding.configuration), 'separator') ??
        (encoding.name === 'v2' ? '.' : '/')
    );
    const zeros = (node.shape ?? []).map(() => '0');
    const key =
      encoding.name === 'v2' ? zeros.join(separator) || '0' : ['c', ...zeros].join(separator);
    paths.push(`${path}/${key}`);
  }
  return paths;
}

/** An all-fill shard (often a mask) is never written, so try a few before reporting failure. */
async function shardHead(base: string, metadata: Metadata): Promise<ProbeRecord> {
  const candidates = shardPaths(metadata).slice(0, 4);
  if (candidates.length === 0) return { ok: true, skipped: 'no sharded arrays' };
  let first: ProbeRecord | undefined;
  let allAbsent = true;
  for (const path of candidates) {
    const result: ProbeRecord = { path, ...(await head(`${base}/${path}`)) };
    if (result.ok === true) return result;
    // Only a visible 404 means "not written"; an opaque failure may be CORS.
    if (result.status !== 404) allAbsent = false;
    first ??= result;
  }
  if (allAbsent) {
    return { ok: true, skipped: `none of ${candidates.length} zero-coordinate shards exists` };
  }
  return { ...first, tried: candidates.length };
}

/** First points Parquet file; a directory of parts often answers HEAD with an HTML listing. */
async function findParquet(base: string, metadata: Metadata): Promise<string | null> {
  const keys = [
    ...new Set(
      Object.keys(metadata)
        .filter((k) => k.startsWith('points/'))
        .map((k) => k.split('/')[1])
    ),
  ];
  for (const key of keys.sort()) {
    for (const path of [
      `points/${key}/points.parquet`,
      `points/${key}/points.parquet/part.0.parquet`,
    ]) {
      const h = await head(`${base}/${path}`);
      if (h.status === 200 && !String(h.contentType ?? '').startsWith('text/html'))
        return `${base}/${path}`;
    }
  }
  return null;
}

async function storeReport(storeUrl: string): Promise<ProbeRecord> {
  const base = storeUrl.replace(/\/$/, '');
  const t0 = performance.now();
  const out: ProbeRecord = { url: base };
  if (new URL(base, location.href).pathname.toLowerCase().endsWith('.zip')) {
    // The zip reader sizes the archive with HEAD, then reads bounded ranges.
    out.head = await head(base);
    // Without a Content-Length on HEAD, the reader takes the size from Content-Range.
    out.bounded = await rangeRead(base, `bytes=0-${PROBE_BYTES - 1}`, !okAt(out, 'head', 'ok'));
    out.ok = okAt(out, 'bounded', 'ok');
  } else {
    let metadata: Metadata = {};
    try {
      const r = await fetch(`${base}/zarr.json`, { cache: 'no-store' });
      const doc: unknown = r.ok ? await r.json() : null;
      const consolidated = Object(Reflect.get(Object(doc), 'consolidated_metadata'));
      metadata = Object(consolidated.metadata);
      out.metadata = {
        ok: r.ok && Object.keys(metadata).length > 0,
        status: r.status,
        entries: Object.keys(metadata).length,
      };
    } catch (e) {
      out.metadata = { ok: false, error: errorText(e) };
    }
    // zarrita: bounded chunk reads, plus HEAD to size a shard before its index.
    out.bounded = await rangeRead(`${base}/zarr.json`, `bytes=0-${PROBE_BYTES - 1}`, false);
    out.shardHead = await shardHead(base, metadata);
    // parquet-wasm: suffix reads for footers, the one shape that needs a CORS preflight.
    const parquet = await findParquet(base, metadata);
    out.parquetSuffix = parquet
      ? { url: parquet, ...(await rangeRead(parquet, `bytes=-${PROBE_BYTES}`, true)) }
      : { ok: true, skipped: 'no points Parquet found' };
    out.ok = ['metadata', 'bounded', 'shardHead', 'parquetSuffix'].every((k) => okAt(out, k, 'ok'));
  }
  out.elapsedMs = Math.round(performance.now() - t0);
  return out;
}

// ------------------------------------------------------------- runtime ------

async function runtimeReport(): Promise<ProbeRecord> {
  const out: ProbeRecord = {
    // 'null' means a sandbox without allow-same-origin: workers, storage and
    // local-network fetches fail there whatever the CSP says.
    origin: self.origin,
    isSecureContext,
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGB: 'deviceMemory' in navigator ? navigator.deviceMemory : null,
    devicePixelRatio,
    userAgent: navigator.userAgent,
  };
  try {
    out.alloc_512MB = new ArrayBuffer(512 * 1024 * 1024).byteLength > 0;
  } catch (e) {
    out.alloc_512MB = errorText(e);
  }
  // A persistent chunk cache would live in one of these. In an opaque-origin
  // sandbox even reading `caches` throws.
  try {
    out.cacheStorage = typeof caches !== 'undefined';
  } catch (e) {
    out.cacheStorage = errorText(e);
  }
  out.indexedDB = await new Promise<boolean | string>((resolve) => {
    try {
      const req = indexedDB.open('spatialdata-probe');
      req.onsuccess = () => {
        req.result.close();
        resolve(true);
      };
      req.onerror = () => resolve(req.error?.message ?? 'error');
    } catch (e) {
      resolve(errorText(e));
    }
  });
  return out;
}

// ------------------------------------------------------------------ all -----

const STEP_TIMEOUT_MS = 10_000;

/** In an unknown host a step can hang rather than fail; that is a result too. */
function withTimeout(run: () => ProbeRecord | Promise<ProbeRecord>): Promise<ProbeRecord> {
  return new Promise<ProbeRecord>((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, error: `no answer after ${STEP_TIMEOUT_MS}ms` }),
      STEP_TIMEOUT_MS
    );
    Promise.resolve()
      .then(run)
      .then(resolve, (e: unknown) => resolve({ ok: false, error: errorText(e) }))
      .finally(() => clearTimeout(timer));
  });
}

/** Yields `[name, result]` as each probe finishes, so a slow one is visible as it runs. */
export async function* runProbes(storeUrls: string[]): AsyncGenerator<[string, ProbeRecord]> {
  violations.length = 0;
  const steps: [string, () => ProbeRecord | Promise<ProbeRecord>][] = [
    ['webgl2', webgl2Report],
    ['webgpu', webgpuReport],
    ['workers', workerReport],
    ['wasm', wasmReport],
    ['blobImport', blobImportReport],
    // One entry per store: a public HTTPS store and a loopback one answer different questions.
    ...storeUrls.map((url, i): [string, () => Promise<ProbeRecord>] => [
      `store_${i}`,
      () => storeReport(url),
    ]),
    ['runtime', runtimeReport],
    ['csp', cspReport],
  ];
  for (const [name, run] of steps) {
    yield [name, await withTimeout(run)];
  }
}

function okAt(results: ProbeRecord, ...path: string[]): boolean {
  let node: unknown = results;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return false;
    node = Reflect.get(node, key);
  }
  return node === true;
}

/** The verdicts that decide the embed design, in a line each. */
export function summarize(results: ProbeRecord): string[] {
  const line = (label: string, ok: boolean) => `${ok ? 'yes' : 'NO '}  ${label}`;
  const origin = Reflect.get(Object(results.runtime), 'origin');
  return [
    `     tile origin: ${typeof origin === 'string' ? origin : 'unknown'}`,
    line('WebGL2 (deck.gl, Viv)', okAt(results, 'webgl2', 'ok')),
    line('WebGPU adapter', okAt(results, 'webgpu', 'ok')),
    line('module workers from blob: URLs', okAt(results, 'workers', 'moduleBlob', 'ok')),
    line('WASM on the main thread', okAt(results, 'wasm', 'ok')),
    line('WASM inside a module worker', okAt(results, 'workers', 'wasmInModuleBlob', 'ok')),
    line('import() of a blob: module', okAt(results, 'blobImport', 'ok')),
    ...Object.entries(results)
      .filter(([key]) => key.startsWith('store_'))
      .map(([key, store]) => {
        const url = String(Reflect.get(Object(store), 'url') ?? key);
        const parts = ['metadata', 'bounded', 'shardHead', 'parquetSuffix', 'head']
          .filter((part) => Reflect.get(Object(store), part) !== undefined)
          .map((part) => {
            const skipped = Reflect.get(Object(Reflect.get(Object(store), part)), 'skipped');
            const verdict = skipped ? 'skipped' : okAt(results, key, part, 'ok') ? 'ok' : 'FAIL';
            return `${part} ${verdict}`;
          });
        return `${line(`store ${url}`, okAt(results, key, 'ok'))}\n       ${parts.join(', ')}`;
      }),
    line(
      'cross-origin isolated (SharedArrayBuffer)',
      okAt(results, 'runtime', 'crossOriginIsolated')
    ),
  ];
}
