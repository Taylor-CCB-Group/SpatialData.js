#!/usr/bin/env node
/**
 * CORS proxy server for local development.
 *
 * Proxies requests to any URL and adds CORS headers to responses.
 * This allows accessing spatialdata stores that don't have CORS headers
 * from browser-based applications.
 *
 * WARNING: This is for local development only. No security features are included.
 */

import { createServer } from 'node:http';
import { URL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const PORT = process.env.PORT || 8081;

/**
 * Add CORS headers to a response
 */
export function addCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * Handle OPTIONS preflight requests
 */
export function handleOptions(req, res) {
  addCorsHeaders(res);
  res.writeHead(200);
  res.end();
}

/**
 * Proxy a request to the target URL
 */
export async function proxyRequest(req, res, targetUrl) {
  try {
    const url = new URL(targetUrl);

    // Build fetch options
    const fetchOptions = {
      method: req.method,
      headers: { ...req.headers },
    };

    // Remove host header (will be set by fetch)
    const { host, 'content-length': contentLength, ...safeHeaders } = fetchOptions.headers;
    fetchOptions.headers = safeHeaders;

    // Forward request body for POST/PUT
    let body = null;
    if (req.method === 'POST' || req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
      if (body.length > 0) {
        fetchOptions.body = body;
      }
    }

    // Make the request
    const response = await fetch(targetUrl, fetchOptions);

    // Add CORS headers
    addCorsHeaders(res);

    // Copy response headers (except CORS-related ones which we set)
    const headersToSkip = new Set([
      'access-control-allow-origin',
      'access-control-allow-methods',
      'access-control-allow-headers',
      'access-control-expose-headers',
      'access-control-max-age',
    ]);

    response.headers.forEach((value, key) => {
      if (!headersToSkip.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    // Set status code
    res.writeHead(response.status, res.getHeaders());

    // Stream response body
    if (response.body) {
      const reader = response.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              res.end();
              break;
            }
            res.write(value);
          }
        } catch (error) {
          console.error('Error streaming response:', error);
          res.end();
        }
      };
      pump();
    } else {
      res.end();
    }
  } catch (error) {
    console.error('Error proxying request:', error);
    addCorsHeaders(res);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Proxy Error: ${error.message}`);
  }
}

/**
 * Handle HTTP request
 */
export async function handleRequest(req, res) {
  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    handleOptions(req, res);
    return;
  }

  try {
    // Extract target URL from query parameter or path
    const url = new URL(req.url, `http://${req.headers.host}`);
    let targetUrl = url.searchParams.get('url') || url.pathname.slice(1);
    // Also support paths like /url=https://... by stripping the "url=" prefix
    if (targetUrl.startsWith('url=')) {
      targetUrl = targetUrl.slice(4);
    }

    if (!targetUrl) {
      addCorsHeaders(res);
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Usage: /?url=<target-url> or /<target-url>');
      return;
    }

    // Validate URL (lightweight check without rejecting valid-but-unexpected forms)
    if (!/^https?:\/\//i.test(targetUrl)) {
      // console.log(`'${targetUrl}' didn't validate, but yolo...`);
      addCorsHeaders(res);
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(
        'Invalid URL. Please provide a full URL starting with http:// or https:// (e.g., https://example.com/data.zarr)'
      );
      return;
    }

    // Proxy the request
    await proxyRequest(req, res, targetUrl);
  } catch (error) {
    console.error('Error handling request:', error);
    addCorsHeaders(res);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
}

/**
 * Create a CORS proxy server
 * @param {number} port - Port to listen on
 * @returns {Promise<import('http').Server>} The HTTP server
 */
export function createProxyServer(port = 8081) {
  const server = createServer(handleRequest);

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      reject(err);
    });

    server.listen(port, () => {
      resolve(server);
    });
  });
}

/**
 * Start a proxy server and return its base URL
 * @param {number} port - Port to start on (will try next port if in use)
 * @returns {Promise<{server: import('http').Server, baseUrl: string}>}
 */
export async function startProxyServer(port = 8081) {
  try {
    const server = await createProxyServer(port);
    // Get the actual port (in case it was changed due to port conflict)
    const actualPort = server.address()?.port || port;
    const baseUrl = `http://localhost:${actualPort}`;
    return { server, baseUrl };
  } catch (error) {
    // If port is in use, try next port
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is in use, trying ${port + 1}...`);
      return startProxyServer(port + 1);
    }
    throw error;
  }
}

// If running as a standalone script, start the server
// Check if this file is being run directly (not imported)
const __filename = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] && resolve(process.argv[1]) === __filename;

if (isMainModule) {
  const server = await createProxyServer(PORT);
  const actualPort = server.address()?.port || PORT;

  console.log(`CORS proxy server running at http://localhost:${actualPort}`);
  console.log('\nUsage:');
  console.log(`  GET http://localhost:${actualPort}/?url=<target-url>`);
  console.log(
    `  Example: http://localhost:${actualPort}/?url=https://example.com/data.zarr/.zattrs`
  );
  console.log('\nPress Ctrl+C to stop\n');

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down proxy server...');
    server.close(() => {
      console.log('Proxy server stopped');
      process.exit(0);
    });
  });
}
