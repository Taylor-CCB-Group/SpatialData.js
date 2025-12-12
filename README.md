# SpatialData.js

A library for interfacing with SpatialData stores in TypeScript/JavaScript.

## Packages

This monorepo contains:

- **[@spatialdata/zarrextra](./packages/zarrextra)** - Utility layer on top of `zarrita` for higher-level representations of metadata
- **[@spatialdata/core](./packages/core)** - Core library for reading and validating SpatialData stores
- **[@spatialdata/react](./packages/react)** - React hooks for providing SpatialData context, with few extra dependencies
- **[@spatialdata/vis](./packages/vis)** - High-level react components for visualising data
- **[docs](./docs)** - Documentation site built with Docusaurus

## Getting Started

### Prerequisites

- Node.js >= 20
- pnpm >= 10
- Python >= 3.12 (for generating test fixtures)
- [uv](https://github.com/astral-sh/uv) (Python package manager)

### Installation

```bash
# Install pnpm globally if you haven't already
npm install -g pnpm

# Install dependencies
pnpm install
```

### Development

```bash
# Build all packages
pnpm build

# Run tests
pnpm test

# Lint code
pnpm lint

# Format code
pnpm format

# Start documentation site
pnpm docs:dev
```

## Testing

### Prerequisites for Testing

To run the full test suite, you'll need:

- Python >= 3.12
- [uv](https://github.com/astral-sh/uv) - Python package manager

#### Setting Up the Python Environment (not required for JS stuff, mostly generating test fixtures)

The Python environment is managed by `uv` and defined in `python/pyproject.toml`. To set it up:

**Installing uv:**
```bash
# Install uv (Unix/macOS)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Or using pip/pipx
pip install uv
# or
pipx install uv
```


**Setting up the environments:**

The project uses completely separate Python environments for each spatialdata version. Each version has its own directory with its own `pyproject.toml` and virtual environment:

```bash
# Set up environment for spatialdata 0.5.0
uv sync --directory python/v0.5.0

# Set up environment for spatialdata 0.6.1
uv sync --directory python/v0.6.1

# Or set up both at once (the fixture generation script will do this automatically)
```

Each environment:
- Is completely independent with its own virtual environment at `python/v{version}/.venv/`
- Has its own `pyproject.toml` that pins a specific spatialdata version
- Is isolated from other versions (no shared base environment)

**Note:** The fixture generation script automatically sets up these environments when needed. You only need to manually sync if you want to activate an environment directly or use it in your editor.

#### Editor Setup

The project includes editor configuration files (`.vscode/settings.json` and `.cursor/settings.json`) that configure the Python interpreter to use one of the version-specific environments (defaults to v0.6.1).

**VS Code / Cursor:**
- The Python interpreter is automatically configured when you open the workspace
- To switch versions: `Cmd/Ctrl+Shift+P` → "Python: Select Interpreter" → Choose:
  - `./python/v0.5.0/.venv/bin/python3` for spatialdata 0.5.0
  - `./python/v0.6.1/.venv/bin/python3` for spatialdata 0.6.1

**Other editors:**
- Choose the appropriate virtual environment:
  - `python/v0.5.0/.venv/bin/python3` for spatialdata 0.5.0
  - `python/v0.6.1/.venv/bin/python3` for spatialdata 0.6.1


### Running Tests

```bash
# Run all tests (unit + integration)
pnpm test:all

# Run only unit tests (fast, no fixtures needed)
pnpm test:unit

# Run only integration tests (requires fixtures)
pnpm test:integration

# Run tests from individual packages
pnpm test
```

### Generating Test Fixtures

Test fixtures are generated on-demand using the Python `spatialdata` library. Each version uses a separate Python environment with the specific spatialdata version pinned to ensure accurate fixture generation.

Fixtures are stored in `test-fixtures/` (excluded from git).

```bash
# Generate fixtures for both spatialdata versions (0.5.0 and 0.6.1)
# This will automatically set up the version-specific environments if needed
pnpm test:fixtures:generate

# Generate fixtures for a specific version
pnpm test:fixtures:generate:0.5.0
pnpm test:fixtures:generate:0.6.1
```

**How it works:**
- The script uses separate environments: `python/v0.5.0/` and `python/v0.6.1/`
- Each environment has its own `pyproject.toml` with the spatialdata version pinned
- The script automatically runs `uv sync` for each environment before generating fixtures
- This ensures fixtures are generated with the exact spatialdata version being tested

**Note:** Integration tests will automatically generate fixtures if they're missing, but you can pre-generate them for faster test runs.

### Test Servers

#### Test Fixture Server

The test fixture server serves generated fixtures over HTTP for testing with `FetchStore`:

```bash
# Start the test fixture server (runs on http://localhost:8080)
pnpm test:server
```

Once running, fixtures are accessible at:
- `http://localhost:8080/test-fixtures/v0.5.0/blobs.zarr`
- `http://localhost:8080/test-fixtures/v0.6.1/blobs.zarr`

The server provides directory listings and serves all zarr metadata files with appropriate CORS headers.

#### CORS Proxy Server

The CORS proxy server allows accessing spatialdata stores that don't have CORS headers enabled. This is useful for local development when testing against remote stores.

```bash
# Start the CORS proxy server (runs on http://localhost:8081)
pnpm test:proxy
```

**Usage:**

Proxy a remote URL by appending it as a query parameter:
```
http://localhost:8081/?url=https://example.com/data.zarr/.zattrs
```

Or use it as a path (for convenience):
```
http://localhost:8081/https://example.com/data.zarr/.zattrs
```

**Example:**

If you have a spatialdata store at `https://example.com/mydata.zarr` that doesn't have CORS headers, you can access it through the proxy:

```typescript
import { readZarr } from '@spatialdata/core';

// Instead of:
// const sdata = await readZarr('https://example.com/mydata.zarr');

// Use the proxy:
const sdata = await readZarr('http://localhost:8081/?url=https://example.com/mydata.zarr');
```

**⚠️ Warning:** The CORS proxy is for local development only. It has no security restrictions and should never be exposed to the internet.


## 📝 License

MIT © Centre For Human Genetics, Oxford University
