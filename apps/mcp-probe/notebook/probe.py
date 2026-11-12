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

    # A public HTTPS store and a loopback one (`pnpm test:server`); STORE_URLS overrides.
    store_urls = os.environ.get("STORE_URLS", "").split(",") if os.environ.get("STORE_URLS") else [
        "https://oranus.cmd.ox.ac.uk/publicprojects/project/13/spatial/Atera_v1_WTA_Kidney_non_diseased_FFPE.zarr",
        "http://localhost:38473/test-fixtures/v0.8.0/blobs.zarr",
    ]
    return ProbeWidget, json, mo, os, store_urls


@app.cell
def _(ProbeWidget, mo, store_urls):
    probe = mo.ui.anywidget(ProbeWidget(store_urls=store_urls))
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
