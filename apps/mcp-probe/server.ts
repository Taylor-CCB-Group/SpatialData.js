import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const RESOURCE_URI = 'ui://spatialdata/probe.html';

/** `pnpm test:server` serves `test-fixtures/` with CORS and range support. */
const DEFAULT_STORE_URL = 'http://localhost:38473/test-fixtures/v0.8.0/blobs.zarr';

function listEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function defaultStoreUrl(): string {
  return process.env.STORE_URL ?? DEFAULT_STORE_URL;
}

/**
 * Origins the View may fetch from. The host turns this into the iframe's
 * `connect-src`, so every origin the View touches must be listed. CSP matches
 * hosts literally, so a `localhost` origin also gets its `127.0.0.1` twin.
 */
export function connectDomains(): string[] {
  const origins = new Set(listEnv('STORE_ORIGINS'));
  origins.add(new URL(defaultStoreUrl()).origin);
  for (const origin of [...origins]) {
    const url = new URL(origin);
    if (url.hostname === 'localhost') origins.add(origin.replace('localhost', '127.0.0.1'));
    if (url.hostname === '127.0.0.1') origins.add(origin.replace('127.0.0.1', 'localhost'));
  }
  return [...origins];
}

/**
 * Stable iframe origin for stores that allowlist origins instead of replying
 * `Access-Control-Allow-Origin: *`. This is Claude's documented form; it only
 * applies to a server reached by URL, so it is omitted unless APP_MCP_URL is set.
 */
function appDomain(): string | undefined {
  const url = process.env.APP_MCP_URL;
  if (!url) return undefined;
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
  return `${hash}.claudemcpcontent.com`;
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'spatialdata-probe', version: '0.1.0' });

  registerAppTool(
    server,
    'open_spatial_probe',
    {
      title: 'Open SpatialData probe',
      description:
        'Open a tile that reports what the host sandbox allows a SpatialData.js viewer to do: ' +
        'WebGL2/WebGPU, blob and module workers, WebAssembly (main thread and in workers), ' +
        'range requests to a SpatialData store, and any CSP violations. The tile adds its ' +
        'results to the model context when it finishes.',
      inputSchema: z.object({
        store_url: z
          .string()
          .url()
          .describe('Base URL of a SpatialData .zarr store. Its origin must be allowlisted.')
          .optional(),
      }),
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ store_url }) => {
      const storeUrl = store_url ?? defaultStoreUrl();
      const allowed = connectDomains();
      const origin = new URL(storeUrl).origin;
      const notes = allowed.includes(origin)
        ? []
        : [
            `${origin} is not in the tile's connect-src (${allowed.join(', ')}); ` +
              'fetches will be blocked. Restart the server with STORE_ORIGINS including it.',
          ];
      return {
        content: [{ type: 'text', text: ['Opened SpatialData probe.', ...notes].join(' ') }],
        structuredContent: { store_url: storeUrl, connect_domains: allowed },
      };
    }
  );

  // Hidden from the model: the View calls this to put its results in the transcript.
  registerAppTool(
    server,
    'report_probe',
    {
      title: 'Report probe results',
      description: 'Called by the probe tile to hand its results back to the conversation.',
      inputSchema: z.object({ results: z.record(z.string(), z.unknown()) }),
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ['app'] } },
    },
    async ({ results }) => ({
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
      structuredContent: results,
    })
  );

  registerAppResource(
    server,
    'SpatialData probe view',
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const html = await fs.readFile(path.join(DIST_DIR, 'mcp-app.html'), 'utf-8');
      const domain = appDomain();
      const resourceDomains = listEnv('RESOURCE_DOMAINS');
      return {
        contents: [
          {
            uri: RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                csp: {
                  connectDomains: connectDomains(),
                  ...(resourceDomains.length > 0 ? { resourceDomains } : {}),
                },
                ...(domain ? { domain } : {}),
              },
            },
          },
        ],
      };
    }
  );

  return server;
}
