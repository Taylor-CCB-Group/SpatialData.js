# `@zarrita/storage` build issue

While copying Vitessce code across, I had initially disabled use of `ZipFileStore` because I had a memory of it being problematic for me in earlier prototypes - and marked 'experimental' in the zarrita documentation.

At some point I thought that I was satisfied it was in fact working ok - but now I notice that there is in fact a related issues showing up, even without `ZipFileStore`, but perhaps more generally with `'@zarrita/storage'`?
{/* truncate */}
```
error during build:
│ ../../node_modules/.pnpm/@zarrita+storage@0.1.3/node_modules/@zarrita/storage/dist/src/fs.js (1:9): "Buffer" is not exported by "__vite-browser-external", imported by "..…
│ file: /Users/ptodd/code/www/SpatialData.ts/node_modules/.pnpm/@zarrita+storage@0.1.3/node_modules/@zarrita/storage/dist/src/fs.js:1:9
│ 1: import { Buffer } from "node:buffer";
│             ^
│ 2: import * as fs from "node:fs";
│ 3: import * as path from "node:path";
....
└─ Failed in 940ms at /Users/ptodd/code/www/SpatialData.ts/packages/core
```

I had previously added a [vite-plugin-node-polyfills](https://www.npmjs.com/package/vite-plugin-node-polyfills) to MDV which meant that it was working in the Vite dev-server... but then I realised that the actual build script was broken, and in the brief time I spent looking at it, I couldn't seem to make both dev and build work - so I attributed it to the experimental nature of `ZipFileStore` and moved on (we've yet to make use of `zarrita` in mainline MDV, but at least everything seemed ok without that being used).

I don't entirely know what I've done to cause `...@zarrita/storage/dist/src/fs.js` to be included in the build - `fs.js` sounds like something that shouldn't be invoked in front-end code (unless I suppose it's using emscripten filesystem or something, which come to think of it could make sense). Anyway, it seems like a zarrita bug, but I'm still not entirely sure - I'll try to make a minimal repro at some point.

Now - clearly the code used in Vitessce is building ok there, and glancing at their vite config I can't see anything obviously in place that is supposed to mitigate this particular issue. I'm not sure what is so different about how our builds are configured that would cause it to be different.

Looking at the places where `'@zarrita/storage'` is used, I think we can refactor such that the `DataSourceParams` needed by things in the file currently named `VZarrDataSource.ts` always use the store that other SpatialData.js code is already creating. I would like to be able to support `ZipFileStore`, and in future we'll need more careful consideration around writeable-stores etc etc, but for now I think we can remove some of the code previously copied from vitessce and it at least builds ok.