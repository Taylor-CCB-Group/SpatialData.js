---
'@spatialdata/core': patch
---

Fetch each parquet part once per points load, not once per concurrent step; a non-Morton
points layer made ~20 requests where it now makes a handful.

`part.N.parquet` enumeration is capped at 512 parts and throws past that, instead of
walking forever against a server that answers every part path.
