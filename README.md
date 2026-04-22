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

- [Volta](https://volta.sh/) for managing the pinned Node.js and pnpm versions
- Python >= 3.12 (for generating test fixtures)
- [uv](https://github.com/astral-sh/uv) (Python package manager)

If you prefer not to use Volta, use Node.js >= 20.19 (or 22.12+) and pnpm >= 10.

### Installation

```bash
# Install Volta once
curl https://get.volta.sh | bash

# Restart your shell so Volta is on PATH
volta install node@24.14.1 pnpm@10.33.0

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

### Quick Node REPL Check

To try `readZarr` in a Node REPL from this repo, first generate the example fixture. `test-fixtures/` is gitignored, so a fresh checkout will not have it yet:

```bash
pnpm test:fixtures:generate:0.7.2
pnpm build
node
```

Then:

```js
const { readZarr } = await import('./packages/core/dist/index.js');
const { FileSystemStore } = await import('@zarrita/storage');
const sdata = await readZarr(new FileSystemStore('./test-fixtures/v0.7.2/blobs.zarr'));

sdata.toString();
```

For more detail, including URL-backed examples, see [packages/core/README.md](./packages/core/README.md).

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

# Set up environment for spatialdata 0.7.2
uv sync --directory python/v0.7.2

# Or set up all at once (the fixture generation script will do this automatically)
```

Each environment:
- Is completely independent with its own virtual environment at `python/v{version}/.venv/`
- Has its own `pyproject.toml` that pins a specific spatialdata version
- Is isolated from other versions (no shared base environment)

**Note:** The fixture generation script automatically sets up these environments when needed. You only need to manually sync if you want to activate an environment directly or use it in your editor.

**Version Mapping:**
- **spatialdata 0.5.0** uses **OME-NGFF 0.4** format (multiscales at top level) in **zarr v2** stores (consolidated `zmetadata`)
- **spatialdata 0.6.0+** uses **OME-NGFF 0.5** format (multiscales nested under `ome` key) in **zarr v3** stores (consolidated `zarr.json`)

#### Editor Setup

The project includes editor configuration files (`.vscode/settings.json` and `.cursor/settings.json`) that configure the Python interpreter to use one of the version-specific environments (defaults to v0.6.1).

**VS Code / Cursor:**
- The Python interpreter is automatically configured when you open the workspace
- To switch versions: `Cmd/Ctrl+Shift+P` → "Python: Select Interpreter" → Choose:
  - `./python/v0.5.0/.venv/bin/python3` for spatialdata 0.5.0
  - `./python/v0.6.1/.venv/bin/python3` for spatialdata 0.6.1
  - `./python/v0.7.2/.venv/bin/python3` for spatialdata 0.7.2

**Other editors:**
- Choose the appropriate virtual environment:
  - `python/v0.5.0/.venv/bin/python3` for spatialdata 0.5.0
  - `python/v0.6.1/.venv/bin/python3` for spatialdata 0.6.1
  - `python/v0.7.2/.venv/bin/python3` for spatialdata 0.7.2


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
# Generate fixtures for all spatialdata versions (0.5.0, 0.6.1, and 0.7.2)
# This will automatically set up the version-specific environments if needed
pnpm test:fixtures:generate

# Generate fixtures for a specific version
pnpm test:fixtures:generate:0.5.0
pnpm test:fixtures:generate:0.6.1
pnpm test:fixtures:generate:0.7.2
```

**How it works:**
- The script uses separate environments: `python/v0.5.0/`, `python/v0.6.1/`, and `python/v0.7.2/`
- Each environment has its own `pyproject.toml` with the spatialdata version pinned
- The script automatically runs `uv sync` for each environment before generating fixtures
- This ensures fixtures are generated with the exact spatialdata version being tested

**Note:** Integration tests will automatically generate fixtures if they're missing, but you can pre-generate them for faster test runs.

### Test Servers

#### Test Fixture Server

The main Node integration tests now load fixtures directly from a `FileSystemStore`. This server is still useful for HTTP smoke tests and browser-oriented local development with `FetchStore`:

```bash
# Start the test fixture server (runs on http://localhost:8080)
pnpm test:server
```

Once running, fixtures are accessible at:
- `http://localhost:8080/test-fixtures/v0.5.0/blobs.zarr`
- `http://localhost:8080/test-fixtures/v0.6.1/blobs.zarr`
- `http://localhost:8080/test-fixtures/v0.7.2/blobs.zarr`

The server provides directory listings and serves all zarr metadata files with appropriate CORS headers.

#### CORS Proxy Server

The CORS proxy server allows accessing spatialdata stores that don't have CORS headers enabled. This is useful for local development when testing against remote stores.

**Standalone Usage:**

```bash
# Start the CORS proxy server (runs on http://localhost:8081)
pnpm test:proxy
```

**Usage:**

Proxy a remote URL using query parameter:
```
http://localhost:8081/?url=https://example.com/data.zarr/.zattrs
```

**Example:**

If you have a spatialdata store at `https://example.com/mydata.zarr` that doesn't have CORS headers, you can access it through the proxy:

```typescript
import { readZarr } from '@spatialdata/core';

// Instead of:
// const sdata = await readZarr('https://example.com/mydata.zarr');

// Use the proxy (query parameter form):
const sdata = await readZarr('http://localhost:8081/?url=https://example.com/mydata.zarr');
```

**Automatic Proxy Management:**

The validation script (`pnpm validate:datasets:js`) automatically manages its own proxy server. The proxy is started at the beginning of validation and stopped when complete, so you don't need to run it separately.

**⚠️ Warning:** The CORS proxy is for local development only. It has no security restrictions and should never be exposed to the internet.

### Dataset Validation

The project includes a script to validate dataset compatibility with the JavaScript implementation using publicly available spatialdata datasets.

#### Validating with JavaScript

Test datasets with the JavaScript implementation in Node.js (outside browser):

```bash
# First, build the packages
pnpm build

# Validate all datasets with JS implementation
pnpm validate:datasets:js

# Validate a specific dataset
pnpm validate:datasets:js -- --dataset "Xenium"

# Output to a file
pnpm validate:datasets:js -- --output-file validation-results-js.md
```

**Note:** The validation script automatically starts its own CORS proxy server, uses it for all requests, and shuts it down when validation completes. You don't need to run `pnpm test:proxy` separately.

#### Understanding the Results

The validation script generates a table showing which datasets work with the JavaScript implementation:

- ✅ Success: Dataset loaded successfully
- ❌ Failed: Dataset could not be loaded
- ⏭️ Not tested: Dataset was skipped

The detailed results include:
- Element types present (images, labels, points, shapes, tables)
- Coordinate systems
- Error messages for failures

This is useful for:
- Testing compatibility of the JavaScript implementation with real-world datasets
- Identifying issues with specific datasets
- Tracking which datasets are known to work or fail

#### Output Formats

The validation script supports multiple output formats:

```bash
# Markdown (default) - Human-readable report
pnpm validate:datasets:js -- --output-format markdown --output-file results.md

# JSON - Machine-readable results
pnpm validate:datasets:js -- --output-format json --output-file results.json

# CSV - Spreadsheet-friendly format
pnpm validate:datasets:js -- --output-format csv --output-file results.csv
```


## 📝 License

MIT © Centre For Human Genetics, Oxford University
