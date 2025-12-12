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
import { URL } from 'node:url';

const PORT = process.env.PORT || 8081;

/**
 * Add CORS headers to a response
 */
function addCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * Handle OPTIONS preflight requests
 */
function handleOptions(req, res) {
  addCorsHeaders(res);
  res.writeHead(200);
  res.end();
}

/**
 * Proxy a request to the target URL
 */
async function proxyRequest(req, res, targetUrl) {
  try {
    const url = new URL(targetUrl);
    
    // Build fetch options
    const fetchOptions = {
      method: req.method,
      headers: { ...req.headers },
    };
    
    // Remove host header (will be set by fetch)
    delete fetchOptions.headers.host;
    delete fetchOptions.headers['content-length'];
    
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
async function handleRequest(req, res) {
  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    handleOptions(req, res);
    return;
  }
  
  try {
    // Extract target URL from query parameter or path
    const url = new URL(req.url, `http://${req.headers.host}`);
    const targetUrl = url.searchParams.get('url') || url.pathname.slice(1);
    
    if (!targetUrl) {
      addCorsHeaders(res);
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Usage: /?url=<target-url> or /<target-url>');
      return;
    }
    
    // Validate URL
    let target;
    try {
      target = new URL(targetUrl);
    } catch (error) {
      // If not a full URL, try to construct one
      // For relative paths, we can't proxy them
      addCorsHeaders(res);
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid URL. Please provide a full URL (e.g., https://example.com/data.zarr)');
      return;
    }
    
    // Only allow http/https protocols
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      addCorsHeaders(res);
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Only http and https protocols are supported');
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

// Create and start server
const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`CORS proxy server running at http://localhost:${PORT}`);
  console.log(`\nUsage:`);
  console.log(`  GET http://localhost:${PORT}/?url=<target-url>`);
  console.log(`  Example: http://localhost:${PORT}/?url=https://example.com/data.zarr/.zattrs`);
  console.log(`\nPress Ctrl+C to stop\n`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down proxy server...');
  server.close(() => {
    console.log('Proxy server stopped');
    process.exit(0);
  });
});

