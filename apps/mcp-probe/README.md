# mcp-probe

An MCP App ([SEP-1865](https://github.com/modelcontextprotocol/ext-apps)) that reports what a
host's sandboxed iframe lets a SpatialData.js view do: WebGL2/WebGPU, blob and module workers,
WASM on the main thread and inside a worker, `import()` of blob modules, range requests to a
store, storage, and every CSP violation by directive. It is not a viewer; it decides how the
embeddable viewer has to be built. See [docs/plans/claude-embedding.md](../../docs/plans/claude-embedding.md).

When the probe finishes, the tile sends a one-line-per-capability summary to the model through
`ui/update-model-context`, so you can ask the agent what it found. The agent can also call
`get_probe` and `rerun_probe` on the live tile.

## Run

```bash
pnpm test:server                                      # fixture store on :38473, CORS + ranges
pnpm --filter @spatialdata/mcp-probe start            # builds the View, MCP on 127.0.0.1:3001/mcp
```

Environment variables:

- `STORE_URL` is the default store to probe.
- `STORE_ORIGINS` lists extra origins for the tile's `connect-src`. The origin of `STORE_URL` is
  always included.
- `APP_MCP_URL` adds Claude's stable `_meta.ui.domain`, for stores that allowlist origins.
- `HOST` and `MCP_ALLOWED_HOSTS` let a tunnel reach the server.

`node main.ts --stdio` serves the same tools over stdio instead.

To try it in a host, register the server as a custom connector. In Claude Science, use the
remote URL `http://127.0.0.1:3001/mcp`, or a local command running `node <abs path>/main.ts
--stdio`. Then ask the agent to call `open_spatial_probe`. claude.ai on the web needs a public
HTTPS URL, so run it behind a tunnel.

## Harness

`pnpm --filter @spatialdata/mcp-probe harness` (or the `mcp-probe-harness` launch config) serves a
minimal host at `http://localhost:5190/harness.html`. It needs the MCP server running. It reads the
resource, applies the CSP the spec requires for the declared domains, and calls the tool. Use it
to check that a change to the View still reports both passes and failures:

| mode | expect |
| --- | --- |
| `?csp=none` | everything but cross-origin isolation passes |
| `?csp=spec` | store passes; workers (`worker-src blob`), WASM (`script-src wasm-eval`) and blob `import()` are blocked |
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
