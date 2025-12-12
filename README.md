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


## 📝 License

MIT © Centre For Human Genetics, Oxford University
