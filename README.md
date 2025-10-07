# SpatialData.ts

A library for interfacing with SpatialData stores in TypeScript/JavaScript.

## 📦 Packages

This monorepo contains:

- **[@spatialdata/core](./packages/core)** - Core library for reading and validating SpatialData stores
- **[docs](./docs)** - Documentation site built with Docusaurus

## 🚀 Getting Started

### Prerequisites

- Node.js >= 18
- pnpm >= 8

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

## 🛠️ Tech Stack

- **pnpm** - Fast, disk space efficient package manager
- **TypeScript** - Type-safe JavaScript
- **Vite** - Next generation frontend tooling for building
- **Vitest** - Blazing fast unit test framework
- **Biome** - Fast formatter and linter
- **Zod** - TypeScript-first schema validation
- **zarrita** - JavaScript implementation for reading Zarr stores
- **Docusaurus** - Modern static website generator

## 📝 License

MIT © Wellcome Centre of Human Genetics
