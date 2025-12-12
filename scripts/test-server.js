#!/usr/bin/env node
/**
 * Simple static file server for serving test fixtures.
 * 
 * Serves the test-fixtures directory so that fixtures can be accessed
 * via HTTP URLs for testing with FetchStore.
 */

import { createServer } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const fixturesDir = join(projectRoot, 'test-fixtures');

const PORT = process.env.PORT || 8080;

/**
 * Get MIME type for a file based on extension
 */
function getMimeType(filePath) {
  const ext = extname(filePath).toLowerCase();
  const mimeTypes = {
    '.json': 'application/json',
    '.zarr': 'application/octet-stream',
    '.zattrs': 'application/json',
    '.zarray': 'application/json',
    '.zgroup': 'application/json',
    '.zmetadata': 'application/json',
    '.html': 'text/html',
    '.txt': 'text/plain',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Generate HTML directory listing
 */
function generateDirectoryListing(files, currentPath, basePath) {
  const items = files
    .map((file) => {
      const isDir = file.isDirectory;
      const href = `${currentPath}/${file.name}${isDir ? '/' : ''}`;
      const icon = isDir ? '📁' : '📄';
      return `<li><a href="${href}">${icon} ${file.name}</a></li>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <title>Test Fixtures - ${currentPath}</title>
  <style>
    body { font-family: monospace; padding: 20px; }
    ul { list-style: none; padding: 0; }
    li { padding: 5px 0; }
    a { text-decoration: none; color: #0066cc; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Test Fixtures</h1>
  <p>Path: ${currentPath}</p>
  <ul>
    ${items}
  </ul>
</body>
</html>`;
}

/**
 * Handle HTTP request
 */
async function handleRequest(req, res) {
  try {
    // Remove query string and normalize path
    const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
    
    // Remove leading /test-fixtures if present (for cleaner URLs)
    let filePath = urlPath.startsWith('/test-fixtures')
      ? urlPath.slice('/test-fixtures'.length)
      : urlPath;
    
    // Remove leading slash
    filePath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
    
    // Resolve to fixtures directory
    const fullPath = join(fixturesDir, filePath);
    
    // Security: ensure path is within fixtures directory
    if (!fullPath.startsWith(fixturesDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    
    // Check if path exists
    const stats = await stat(fullPath).catch(() => null);
    
    if (!stats) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    
    // Handle directory listing
    if (stats.isDirectory()) {
      const files = await readdir(fullPath, { withFileTypes: true });
      const fileList = files.map((file) => ({
        name: file.name,
        isDirectory: file.isDirectory(),
      }));
      
      const html = generateDirectoryListing(fileList, urlPath, '/test-fixtures');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }
    
    // Serve file
    const content = await readFile(fullPath);
    const mimeType = getMimeType(fullPath);
    
    // Add CORS headers for cross-origin requests
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Content-Length': content.length,
    });
    
    res.end(content);
  } catch (error) {
    console.error('Error handling request:', error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
}

// Create and start server
const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`Test fixture server running at http://localhost:${PORT}`);
  console.log(`Serving fixtures from: ${fixturesDir}`);
  console.log(`\nAccess fixtures at: http://localhost:${PORT}/test-fixtures/`);
  console.log(`Press Ctrl+C to stop\n`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});

