"""The SpatialData capability probe as an anywidget (marimo, Jupyter).

Build the module first: `pnpm --filter @spatialdata/mcp-probe build`.
"""

from pathlib import Path

import anywidget
import traitlets

WIDGET_JS = Path(__file__).parent.parent / "dist" / "widget.js"


class ProbeWidget(anywidget.AnyWidget):
    _esm = WIDGET_JS
    store_urls = traitlets.List(traitlets.Unicode()).tag(sync=True)
    results = traitlets.Dict().tag(sync=True)
