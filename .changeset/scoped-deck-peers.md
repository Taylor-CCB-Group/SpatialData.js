---
"@spatialdata/layers": minor
"@spatialdata/vis": minor
---

`deck.gl` is no longer a dependency or peer, so installing these packages no longer pulls in the ArcGIS, CARTO, Google Maps and Mapbox integrations. Instead, install `@deck.gl/core`, `@deck.gl/layers`, `@deck.gl/geo-layers`, `@deck.gl/react` and `@deck.gl/widgets` (~9.4). The last two are needed by Viv.
