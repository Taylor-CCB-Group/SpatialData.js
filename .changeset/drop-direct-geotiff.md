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

No public API changes, and no effect on OME-TIFF support: that runs through viv's
own `loadOmeTiff`, which resolves its own `geotiff` (`^2.0.5`) independently of
what we declare. Declaring the dependency ourselves only ever added a second copy
to consumers' trees — and pinned us to a version we could neither exercise nor
usefully advance, since geotiff 3's decoder API is a viv-side blocker
(hms-dbmi/viv#951), not ours.
