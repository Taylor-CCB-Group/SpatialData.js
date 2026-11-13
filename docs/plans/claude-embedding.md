# Embedding SpatialData.js in Claude and other hosts

**Status:** the store-preparation and hosting skills are in [`skills/`](../../skills). The step 1
probe is built (`apps/mcp-probe` on branch `claude/skills-ui-protocols-widget-2fb871`, not on
`main`) but has not yet been run in Claude. **Vocabulary:** [CONTEXT.md](../../CONTEXT.md)
(*Render Stack*).

The goal is one embeddable viewer that several hosts mount:

| host | adds |
| --- | --- |
| demo page | already opens a local folder or zip, with no server |
| MCP App (Claude Science, claude.ai, Desktop) | tile, server tools, skill, plugin |
| marimo and Jupyter (anywidget) | the same ES module, state synced both ways; see [Notebooks](#notebooks-marimo-first) |
| `sdjs serve <root>` (npm and PyPI) | local store server, a browsable list of the stores under a root |

Two shared pieces carry all of them:

- **A controller and state protocol.** `createViewer(el, opts)` returns
  `{ getState, setState, subscribe }` over `SpatialCanvasViewer`. The state is
  `{ storeUrl, coordinateSystem, renderStack, viewState }` plus selection. Do not invent a
  second snapshot format: `RenderStack` is already versioned and has a zod schema, which also
  becomes the MCP tool `inputSchema`. The agent reads this state to know what the user is
  looking at, so it has to be legible.
- **A local store server.** It serves a directory or zip with CORS, `Range`, suffix ranges, and
  exposed `Content-Length`/`Content-Range`. The CLI, the Python command, a local MCP server and
  the "local file in a tile" case all need it.
  - **Access control.** CORS must allow any origin, because sandboxed views send
    `Origin: null`. So origin checks cannot be the gate. Instead, every server serves its
    stores under a random path token and binds to loopback. The token goes in the URL handed
    to the viewer, and any page without it gets a 404.
  - `serve_store.py` in the hosting skill implements this in the standard library, and
    `check_hosting.py` is its acceptance test. The CLI and MCP server should match it, and
    add a check that the `Host` header is loopback.

## What the sandbox allows

An MCP App View is one HTML document in a sandboxed iframe. Its CSP comes from the resource's
`_meta.ui.csp`. The spec offers `connectDomains`, `resourceDomains`, `frameDomains` and
`baseUriDomains`, and nothing that grants `worker-src blob:` or `wasm-unsafe-eval`
([ext-apps#566](https://github.com/modelcontextprotocol/ext-apps/issues/566),
[#605](https://github.com/modelcontextprotocol/ext-apps/issues/605)). Against the CSP the spec
requires by default, the probe harness shows blob workers, WASM compilation and blob `import()`
blocked, while a declared store origin is reachable. Our codecs and parquet reader are WASM in
module workers, so if Claude enforces exactly that policy, the single-file build has to change:

- decode without WASM (pure-JS codecs on the main thread);
- decode on the MCP server and serve tiles; or
- wait for the spec to allow WASM.

Run the probe in Claude Science, claude.ai and Desktop before choosing. Claude's production CSP is
not documented.

## Notebooks: marimo first

marimo is the primary notebook target. It runs anywidget widgets natively
(`mo.ui.anywidget`), so one widget covers marimo and Jupyter.

marimo also makes a widget's synced traits a reactive value. Viewport or
selection changes in the viewer then re-run the cells that read them, without
callbacks. The synced state is the controller's `{ renderStack, viewState,
selection }` plus the store reference. Python sets `renderStack` from data, and
reads back what the user is looking at.

Measured in local marimo 0.25 with anywidget 0.11 (the probe as an anywidget, on the probe
branch):

- **Workers and WASM run.** The widget renders in the notebook page, in a shadow root rather
  than an iframe, with no CSP. Blob workers, module workers, WASM inside a worker and blob
  `import()` all pass, and the page is not cross-origin isolated.
- **Sibling files are not resolvable.** marimo serves the module as a virtual file
  (`/@file/<id>.js`). `new URL('./worker.js', import.meta.url)` therefore points at a path
  that returns 404. The widget needs the same self-contained build as the MCP App, with
  workers and WASM inlined. That build is the shared artefact, and here it runs unrestricted.
- **A loopback store server is reachable** from the notebook page, with ranges and CORS. A
  local kernel can start one (as `serve_store.py` does) and pass its URL.
- **marimo's virtual-file route answers bounded and suffix ranges** (206), on the notebook's
  own origin. That makes it a candidate for serving a store through a hosted kernel, where
  the browser cannot reach the kernel's `localhost`, but it only serves files marimo has
  registered. Whether a store tree can be exposed through it is open.

Still to measure:
- hosted marimo, where the kernel runs remotely;
- marimo WASM notebooks: Python in Pyodide, no server route for local stores;
- Jupyter.

## Steps

1. **Capability probe** (built, unmerged). Next: run it in each Claude surface and record the
   results here.
2. **Controller and single-file embed build**, with decode fallbacks chosen by step 1. Drive the
   canvas from a `ResizeObserver`; the host resizes tiles.
3. **CLI and local store server** (built: `packages/cli`, `python/sdjs`, not yet published).
   - `sdjs serve [root]` finds `*.zarr` and `*.zarr.zip` under root, stopping at each store,
     and serves the bundled viewer at `/` with `?catalog=<prefix>/catalog.json`. Store files
     are under `<prefix>/data/`, and only paths inside a store are served.
   - The Node and Python servers are separate implementations with matching tests; keep
     them in step.
   - The viewer's catalog mode reads any `{ stores: [{ path, url }] }` with URLs relative to
     the catalog, so a statically hosted `catalog.json` works the same way.
   - **Naming.** PyPI `sdjs` is free. npm will refuse unscoped `sdjs` as too close to
     `sd.js`, so the npm package is `@spatialdata/cli` with an `sdjs` bin
     (`npx @spatialdata/cli serve`).
4. **MCP server, skill and plugin.**
   - Server tools:
     - `describe_store` (read with core in Node, list elements, coordinate systems and table
       columns);
     - `show_spatialdata`, which takes `{ store, renderStack, viewState? }`. `store` is a URL,
       or for a local MCP server a path under its root, which the server maps to a token URL.
       A `RenderStack` names elements but not the store they belong to;
     - app-only tools so the tile can hand state back.
   - Give `entry.props` a typed schema per element type first. It is `record<string, unknown>`
     today, so the model gets no guidance.
   - Tool results over ~150k characters never reach the tile in Claude, so data goes by fetch,
     not through results.
   - A viewer skill covers inspecting a store and writing render stacks, and builds on the
     existing store-preparation and hosting skills.
5. **anywidget**, for marimo and Jupyter, on the self-contained build; see
   [Notebooks](#notebooks-marimo-first).

## Open questions

- Whether Claude Science renders MCP App tiles, and how its `host.app(...)(artifact_id=...)`
  binding works. That binding is a host convention beyond SEP-1865.
- Local stores in a tile. The tile's origin must reach the store server.
  - An opaque origin does not by itself forbid a CORS fetch to localhost. But in the probe
    harness, Chrome blocked localhost fetches from a sandbox without `allow-same-origin`,
    consistent with its local-network restrictions.
  - Whether Claude's hosts allow it, possibly after a permission prompt, needs testing in
    each host.
