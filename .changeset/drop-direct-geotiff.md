---
'@spatialdata/avivatorish': patch
'@spatialdata/vis': patch
---

Drop the direct `geotiff` dependency from both packages.

`@spatialdata/vis` declared it but never imported it. `@spatialdata/avivatorish`
imported `fromUrl` / `fromBlob` in exactly one place, feeding a chain of
non-exported Avivator scaffolding for plain multi-TIFF inputs that nothing
reached — `createLoader` is OME-NGFF-only by design. Both are now gone, along
with the matching Vite `external` entries.

No public API changes, and nothing to lose on the OME-TIFF side: there was no
OME-TIFF loading path to break. The only loaders here are `loadOmeZarr` and
`loadOmeZarrMultiscalesData`, and the exported `OME_TIFF` type is a type-only
derivation from viv's `loadOmeTiff` signature — `import type`, so it costs
nothing at runtime and needs no `geotiff` of our own.

Declaring the dependency only ever added a third copy to consumers' trees, and
pinned us to a version we could neither exercise nor usefully advance: were an
OME-TIFF path ever added, it would go through viv, which resolves its own
`geotiff` (`^2.0.5`) regardless, and geotiff 3's decoder API is a viv-side
blocker (hms-dbmi/viv#951), not ours.
