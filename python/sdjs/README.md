# sdjs

Serve local [SpatialData](https://spatialdata.scverse.org/) stores and browse them in the
[SpatialData.js](https://github.com/Taylor-CCB-Group/SpatialData.js) viewer.

```bash
uvx sdjs serve ~/data
```

Finds every `*.zarr` and `*.zarr.zip` under the directory (nested, stopping at each
store), serves them on loopback, and opens the viewer with a picker over them. Pass a
single store to serve just that one.

Store URLs carry a random token, because the server sends `Access-Control-Allow-Origin: *`
so that other viewers can read it too. Use them as you would a password. `--no-token`
serves at a fixed `/stores/` path instead. The catalog is at `<prefix>/catalog.json`
and each store's files are under `<prefix>/data/<path>`.

The same command ships on npm as `@spatialdata/cli`.
