#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findStores, resolveServedRoot } from './catalog.ts';
import { createStoreServer, storesPrefix } from './server.ts';

const USAGE = `Usage: sdjs serve [root] [options]

Serve the SpatialData stores (*.zarr, *.zarr.zip) under root (default: the current
directory), and open them in the bundled viewer.

Options:
  --port <n>     Port (default 8000, or a free one if that is taken)
  --host <addr>  Interface to bind (default 127.0.0.1)
  --no-token     Serve stores at a fixed /stores/ path rather than a random one
  --no-open      Do not open a browser
  --depth <n>    How deep to look for stores (default 8)
`;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref();
}

async function serve(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      'no-token': { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
      depth: { type: 'string', default: '8' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const root = await resolveServedRoot(resolve(positionals[0] ?? '.'));
  const token = values['no-token'] ? null : randomBytes(16).toString('base64url');
  const appDir = fileURLToPath(new URL('../app/', import.meta.url));
  const host = values.host;
  const maxDepth = Number(values.depth);
  const server = createStoreServer({
    root,
    token,
    appDir: existsSync(appDir) ? appDir : null,
    loopbackOnly: LOOPBACK.has(host),
    maxDepth,
  });

  const listen = (p: number) =>
    new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(p, host, () => {
        server.off('error', fail);
        done();
      });
    });
  try {
    await listen(values.port === undefined ? 8000 : Number(values.port));
  } catch (error) {
    // Only the default port falls back; an explicit --port that is taken is an error.
    const inUse = error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
    if (!inUse || values.port !== undefined) throw error;
    await listen(0);
  }
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const catalogPath = `${storesPrefix(token)}catalog.json`;
  const stores = await findStores(root, maxDepth);
  const viewer = `${origin}/?catalog=${encodeURIComponent(catalogPath)}`;
  console.log(`Serving ${stores.length} store(s) under ${root.dir}`);
  for (const path of stores) console.log(`  ${path}`);
  console.log(`\nViewer:  ${viewer}\nCatalog: ${origin}${catalogPath}`);
  if (token) console.log('The URL carries an access token: share it like a password.');
  if (!existsSync(appDir)) console.log('(No bundled viewer in this install; serving data only.)');
  if (!values['no-open'] && existsSync(appDir)) openBrowser(viewer);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === 'serve') return serve(rest);
  process.stdout.write(USAGE);
  if (command !== undefined && command !== '--help' && command !== '-h') process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
