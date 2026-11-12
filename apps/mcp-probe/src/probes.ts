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

async function tryFetch(
  url: string,
  init: RequestInit,
  readHeaders: string[]
): Promise<ProbeRecord> {
  try {
    const r = await fetch(url, init);
    const out: ProbeRecord = { status: r.status, type: r.type };
    // A header the server sends but does not expose reads as null cross-origin.
    for (const name of readHeaders) out[name] = r.headers.get(name);
    if (init.method !== 'HEAD') out.bytes = (await r.arrayBuffer()).byteLength;
    return out;
  } catch (e) {
    return { error: errorText(e) };
  }
}

/**
 * zarrita needs metadata GETs and prefix ranges; parquet footers and zarr
 * shard indexes are read with suffix ranges, and parquet-wasm sizes a file
 * from a HEAD request. Each needs CORS on the store and `connect-src` here.
 */
async function storeReport(storeUrl: string): Promise<ProbeRecord> {
  const url = `${storeUrl.replace(/\/$/, '')}/zarr.json`;
  const t0 = performance.now();
  const metadata = await tryFetch(url, {}, []);
  const prefixRange = await tryFetch(url, { headers: { Range: 'bytes=0-15' } }, ['content-range']);
  const suffixRange = await tryFetch(url, { headers: { Range: 'bytes=-8' } }, ['content-range']);
  const head = await tryFetch(url, { method: 'HEAD' }, ['content-length']);
  return {
    url,
    ok:
      metadata.status === 200 &&
      prefixRange.status === 206 &&
      suffixRange.status === 206 &&
      suffixRange['content-range'] !== null &&
      head['content-length'] !== null,
    metadata,
    prefixRange,
    suffixRange,
    head,
    elapsedMs: Math.round(performance.now() - t0),
  };
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
export async function* runProbes(storeUrl: string): AsyncGenerator<[string, ProbeRecord]> {
  violations.length = 0;
  const steps: [string, () => ProbeRecord | Promise<ProbeRecord>][] = [
    ['webgl2', webgl2Report],
    ['webgpu', webgpuReport],
    ['workers', workerReport],
    ['wasm', wasmReport],
    ['blobImport', blobImportReport],
    ['store', () => storeReport(storeUrl)],
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
    line('store reachable with range + exposed headers', okAt(results, 'store', 'ok')),
    line(
      'cross-origin isolated (SharedArrayBuffer)',
      okAt(results, 'runtime', 'crossOriginIsolated')
    ),
  ];
}
