# mcp-probe

An MCP App ([SEP-1865](https://github.com/modelcontextprotocol/ext-apps)) that reports what a
host's sandboxed iframe lets a SpatialData.js view do: WebGL2/WebGPU, blob and module workers,
WASM on the main thread and inside a worker, `import()` of blob modules, range reads against one
or more stores, storage, and every CSP violation by directive. It is not a viewer; it decides how the
embeddable viewer has to be built. See [docs/plans/claude-embedding.md](../../docs/plans/claude-embedding.md).

When the probe finishes, the tile sends a one-line-per-capability summary to the model through
`ui/update-model-context`, so you can ask the agent what it found. The agent can also call
`get_probe` and `rerun_probe` on the live tile.

## Run

```bash
pnpm test:server                                      # fixture store on :38473, CORS + ranges
pnpm --filter @spatialdata/mcp-probe start            # builds the View, MCP on 127.0.0.1:3001/mcp
```

By default it probes two stores: the demo's public HTTPS store on oranus and the local fixture
store. One run then shows whether the host can range-read the web and whether it can reach a
store on this machine. For each store it makes the requests SpatialData.js makes, the same as
`check_hosting.py` in the hosting skill:

- a metadata `GET`;
- a bounded range;
- a `HEAD` on a shard, which is how zarrita sizes it;
- a suffix range on a points Parquet file, the one request shape that needs a CORS preflight.

A zip URL gets a `HEAD` and a bounded range.

Environment variables:

- `STORE_URLS` is a comma-separated list of stores to probe by default.
- `STORE_ORIGINS` lists extra origins for the tile's `connect-src`. The origins of `STORE_URLS`
  are always included.
- `APP_MCP_URL` adds Claude's stable `_meta.ui.domain`, for stores that allowlist origins.
- `HOST` and `MCP_ALLOWED_HOSTS` let a tunnel reach the server.

For a host that runs connectors as local commands, the build also writes
`dist/server/main.mjs`. It has no dependencies of its own; it needs only Node 18 or later and
the `dist/mcp-app.html` beside it. Copy `dist/` anywhere and register:

```bash
node <abs path>/dist/server/main.mjs --stdio
```

To try it in a host, register the server as a custom connector. In Claude Science, try the
remote URL `http://127.0.0.1:3001/mcp` first, then the local command above. Then ask the agent
to call `open_spatial_probe`. claude.ai on the web needs a public HTTPS URL, so run it behind a
tunnel. Neither route has been tried in Claude yet.

## Harness

`pnpm --filter @spatialdata/mcp-probe harness` (or the `mcp-probe-harness` launch config) serves a
minimal host at `http://localhost:5190/harness.html`. It needs the MCP server running. It reads the
resource, applies the CSP the spec requires for the declared domains, and calls the tool. Pass
`?store=<url>`, repeated, to probe other stores. Use the harness to check that a change to the
View still reports both passes and failures:

| mode | expect |
| --- | --- |
| `?csp=none` | everything but cross-origin isolation passes |
| `?csp=spec` | both stores pass; workers (`worker-src blob`), WASM (`script-src wasm-eval`) and blob `import()` are blocked |
| `?store=https://example.org/x.zarr` | that store fails with a `connect-src` violation; the server warns it is not allowlisted |
| `?sandbox=opaque` | origin `null`: module workers, storage and the localhost store fail even without a CSP |

## Notebook widget (marimo, Jupyter)

The same probes ship as an anywidget (`src/widget.ts`, built to `dist/widget.js`). It reports
where its module was loaded from and whether a sibling worker path resolves. Results sync back to
the kernel as the `results` trait, so in marimo the cell that reads them re-runs.

```bash
pnpm --filter @spatialdata/mcp-probe build
pnpm test:server
cd apps/mcp-probe/notebook && uvx --with anywidget marimo run probe.py
```

Set `PROBE_RESULTS=<file>` to have the kernel write the results as JSON.
