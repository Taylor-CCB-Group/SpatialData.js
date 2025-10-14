# @spatialdata/react

React hooks and components for SpatialData.

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
    <SpatialDataProvider storeUrl={"https://example.com/my.zarr"}>
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

## Build

```bash
pnpm --filter @spatialdata/react build
```
