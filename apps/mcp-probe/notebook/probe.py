import marimo

app = marimo.App()


@app.cell
def _():
    import json
    import os
    import sys
    from pathlib import Path

    import marimo as mo

    sys.path.insert(0, str(Path(__file__).parent))
    from probe_widget import ProbeWidget

    # `pnpm test:server` serves the fixtures with CORS and ranges.
    store_url = os.environ.get(
        "STORE_URL", "http://localhost:38473/test-fixtures/v0.8.0/blobs.zarr"
    )
    return ProbeWidget, json, mo, os, store_url


@app.cell
def _(ProbeWidget, mo, store_url):
    probe = mo.ui.anywidget(ProbeWidget(store_url=store_url))
    probe
    return (probe,)


@app.cell
def _(json, mo, os, probe):
    # Re-runs when the widget syncs its results: the reactive path a viewer would use.
    results = probe.value.get("results") or {}
    out = os.environ.get("PROBE_RESULTS")
    if out and results:
        with open(out, "w") as f:
            json.dump(results, f, indent=2)
    mo.md(f"Kernel received **{len(results)}** probe sections.")
    return


if __name__ == "__main__":
    app.run()
