import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, extname, join } from 'node:path';
import {
  buildCatalog,
  DATA_PREFIX,
  findStores,
  isServablePath,
  type ServedRoot,
} from './catalog.ts';

export interface StoreServerOptions {
  root: ServedRoot;
  /** Random path prefix gating the catalog and data; `null` serves them at `/`. */
  token: string | null;
  /** The built viewer, served at `/`. */
  appDir: string | null;
  /** Refuse requests whose Host is not loopback (DNS rebinding). */
  loopbackOnly: boolean;
  maxDepth?: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function mimeType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function hostName(host: string | undefined): string {
  if (!host) return '';
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
}

const RANGE = /^bytes=(\d*)-(\d*)$/;

type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/** `null` means serve the whole file (no Range, or a form we do not support). */
export function parseRange(header: string | undefined, size: number): ByteRange {
  const match = header ? RANGE.exec(header.trim()) : null;
  if (!match || (match[1] === '' && match[2] === '')) return null;
  const [, first, last] = match;
  const start = first === '' ? Math.max(0, size - Number(last)) : Number(first);
  const end = first === '' || last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, ETag'
  );
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  extraHeaders: Record<string, string> = {}
): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return false;
  const size = info.size;
  const range = parseRange(req.headers.range, size);
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Last-Modified', info.mtime.toUTCString());
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' });
    res.end();
    return true;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const headers: Record<string, string> = {
    'Content-Type': mimeType(path),
    'Content-Length': String(end - start + 1),
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return true;
  }
  createReadStream(path, { start, end })
    .on('error', () => res.destroy())
    .pipe(res);
  return true;
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain', 'Content-Length': '9' });
  res.end('Not found');
}

/** URL path under which the catalog and data are served; the viewer has the rest. */
export function storesPrefix(token: string | null): string {
  return token ? `/${token}/` : '/stores/';
}

export function createStoreServer(options: StoreServerOptions): Server {
  const { root, token, appDir, loopbackOnly, maxDepth } = options;
  const prefix = storesPrefix(token);

  async function handleStores(req: IncomingMessage, res: ServerResponse, rest: string) {
    setCors(res);
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
      // Chrome asks before a public page (such as a sandboxed widget) reads localhost.
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204);
      res.end();
      return;
    }
    if (rest === 'catalog.json') {
      const stores = await findStores(root, maxDepth);
      const body = JSON.stringify(buildCatalog(basename(root.only ?? root.dir), stores));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (rest.startsWith(DATA_PREFIX)) {
      let segments: string[];
      try {
        segments = rest.slice(DATA_PREFIX.length).split('/').map(decodeURIComponent);
      } catch {
        return notFound(res);
      }
      if (
        isServablePath(segments, root.only) &&
        (await sendFile(req, res, join(root.dir, ...segments)))
      ) {
        return;
      }
    }
    notFound(res);
  }

  async function handleApp(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (!appDir) return notFound(res);
    const segments = pathname.split('/').filter(Boolean);
    let decoded: string[];
    try {
      decoded = segments.map(decodeURIComponent);
    } catch {
      return notFound(res);
    }
    if (decoded.some((s) => s === '..' || s.startsWith('.') || /[\\/\0]/.test(s))) {
      return notFound(res);
    }
    if (decoded.length > 0 && (await sendFile(req, res, join(appDir, ...decoded)))) return;
    // The viewer routes by path (/headless, /codec…), so extensionless paths get the page.
    if (decoded.length === 0 || !extname(pathname)) {
      if (await sendFile(req, res, join(appDir, 'index.html'), { 'Cache-Control': 'no-cache' })) {
        return;
      }
    }
    notFound(res);
  }

  return createServer((req, res) => {
    if (loopbackOnly && !LOOPBACK_HOSTS.has(hostName(req.headers.host))) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden host');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' });
      res.end();
      return;
    }
    const pathname = (req.url ?? '/').split('?', 1)[0];
    const handled = pathname.startsWith(prefix)
      ? handleStores(req, res, pathname.slice(prefix.length))
      : handleApp(req, res, pathname);
    handled.catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}
