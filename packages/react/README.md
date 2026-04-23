# @spatialdata/react

React hooks for SpatialData. This package should have a relatively minimal set of dependencies, such that it should be easy to integrate into other React applications. It is mostly focused on providing react-idiomatic ways of accessing the data itself, with appropriate abstractions around the core vanilla API, managing the `async` nature of fetching data etc.

## Install

Using pnpm in this monorepo:

```bash
pnpm --filter @spatialdata/react build
```

## Usage

```tsx
import { SpatialDataProvider, useSpatialData } from '@spatialdata/react';

function App() {
  return (
    <SpatialDataProvider source={"https://example.com/my.zarr"}>
      <Viewer />
    </SpatialDataProvider>
  );
}

function Viewer() {
  const { spatialData, loading, error } = useSpatialData();
  if (loading) return <div>Loading…</div>;
  if (error) return <pre>{String(error)}</pre>;
  if (!spatialData) return null;
  return <pre>{spatialData.toString()}</pre>;
}
```

You can also pass a zarrita store instance via `source` in an application context where this is opened independently.

## Build

```bash
pnpm --filter @spatialdata/react build
```
