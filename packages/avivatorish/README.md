# @spatialdata/avivatorish

Reusable, publishable extraction of **Viv** loaders, **channel / viewer zustand stores**, and **OME** helpers (Avivator / MDV lineage). SpatialData.js, MDV, and other apps should depend on this package instead of vendoring near-duplicates.

## Scope

- **Headless:** `createLoader`, `loadOmeZarrMultiscalesData`, stats helpers (`getMultiSelectionStats`, …), constants.
- **React / Zustand:** `VivProvider`, `createVivStores`, `useImage`, channel and viewer store hooks.

## Non-goals

- **No MobX** — consumers may use MobX at the app boundary; this package stays Zustand + plain functions.
- **deck composition** is not the primary API — orchestration lives in **`@spatialdata/layers`** (`SpatialLayer`) and **`@spatialdata/vis`** (`SpatialCanvas`), not duplicated here.

## Image state model

The long-term shape of serialized “image state” is still **evolving**. Iterate here with lessons from Avivator, MDV, and Vitessce; prefer versioned props in `@spatialdata/layers` for saved scenes.

## Peers

`react`, `react-dom` (>=18 \<20), plus runtime peers implied by your app: `@hms-dbmi/viv`, `geotiff`, `zustand`.

## Repository

`packages/avivatorish` in [SpatialData.js](https://github.com/Taylor-CCB-Group/SpatialData.js).
