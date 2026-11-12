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
  the "local file in a tile" case all need it. `serve_store.py` in the hosting skill is a
  standard-library version, and `check_hosting.py` is its acceptance test.

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

To settle before building, by measurement:

- **Workers and WASM.** anywidget loads the widget module from a string,
  probably through a `blob:` URL, so `import.meta.url` cannot locate worker or
  `.wasm` files. If so, the widget needs the same self-contained build as the
  MCP App (workers and WASM inlined), and that build becomes the shared
  artefact. Notebook pages likely impose no strict CSP, so blob workers and
  WASM should run.
- **Where a local store's bytes come from.**
  - A local kernel can start a loopback range server (as `serve_store.py`
    does) and pass its URL.
  - A remote kernel, such as a hosted marimo or JupyterHub, cannot be reached
    on `localhost`. Bytes would go through the widget's message channel or a
    file route the notebook server provides; find out what marimo offers.
- **marimo WASM notebooks.** Python runs in Pyodide in the page, so a
  URL-driven widget works for remote stores, but there is no server route for
  local ones.

The step 1 probe answers the first two. `probes.ts` does not depend on MCP, so
wrap it as an anywidget and run it in marimo (local and hosted) and Jupyter.

## Steps

1. **Capability probe** (built, unmerged). Next: run it in each Claude surface and record the
   results here.
2. **Controller and single-file embed build**, with decode fallbacks chosen by step 1. Drive the
   canvas from a `ResizeObserver`; the host resizes tiles.
3. **CLI and local store server.** These do not depend on the sandbox result.
   - `sdjs serve <root>` discovers SpatialData stores (`*.zarr`, `*.zarr.zip`) in nested
     directories and stops at each store.
   - It serves an index of them as JSON alongside the data, and opens the demo built into the
     package on loopback. A hosted public page cannot reliably read `localhost`.
   - The demo gains a catalog mode that reads such an index. A statically hosted index then
     works the same way as the CLI.
   - **Naming.** `sdjs` is free on PyPI. npm will likely refuse it unscoped because `sd.js`
     exists, so the fallback is a scoped package with an `sdjs` bin. Keep the Python package
     light, without the `write` stack.
4. **MCP server, skill and plugin.**
   - Server tools:
     - `describe_store` (read with core in Node, list elements, coordinate systems and table
       columns);
     - `show_spatialdata` (takes a `RenderStack`);
     - app-only tools so the tile can hand state back.
   - Give `entry.props` a typed schema per element type first. It is `record<string, unknown>`
     today, so the model gets no guidance.
   - Tool results over ~150k characters never reach the tile in Claude, so data goes by fetch,
     not through results.
   - A viewer skill covers inspecting a store and writing render stacks, and builds on the
     existing store-preparation and hosting skills.
5. **anywidget**, for marimo and Jupyter, after the notebook probe; see [Notebooks](#notebooks-marimo-first).

## Open questions

- Whether Claude Science renders MCP App tiles, and how its `host.app(...)(artifact_id=...)`
  binding works. That binding is a host convention beyond SEP-1865.
- Local stores in a tile. The tile's origin must reach the store server, and sandboxes without
  `allow-same-origin` cannot fetch localhost at all.
