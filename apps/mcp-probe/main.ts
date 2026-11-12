import { createServer as createHttpServer } from 'node:http';
import {
  hostHeaderValidation,
  localhostHostValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { connectDomains, createServer, defaultStoreUrls } from './server.ts';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Loopback-only by default. To reach it through a tunnel, set HOST and list the
 * tunnel's hostname in MCP_ALLOWED_HOSTS so DNS-rebinding protection admits it.
 */
function startHttp(): void {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.MCP_PORT ?? 3001);
  const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const validateHost =
    allowedHosts.length > 0
      ? hostHeaderValidation(['localhost', '127.0.0.1', '[::1]', ...allowedHosts])
      : localhostHostValidation();

  const httpServer = createHttpServer(async (req, res) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (!validateHost(req, res)) return;
    // Claude calls this from its own process, not a page, so CORS is only for
    // browser-based local hosts (the harness, MCP Inspector).
    const origin = req.headers.origin;
    // Sandboxed frames send `Origin: null`, which does not parse.
    if (origin && URL.canParse(origin) && LOOPBACK.has(new URL(origin).hostname)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id'
      );
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    // Stateless: a fresh server and transport per request.
    const server = createServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('MCP error:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          })
        );
      }
    }
  });

  httpServer.listen(port, host, () => {
    console.log(`MCP server: http://${host}:${port}/mcp`);
    console.log(`Default stores: ${defaultStoreUrls().join(' ')}`);
    console.log(`Tile connect-src: ${connectDomains().join(' ')}`);
  });
  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv.includes('--stdio')) {
  await createServer().connect(new StdioServerTransport());
} else {
  startHttp();
}
