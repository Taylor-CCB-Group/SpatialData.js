"""Widgets that work around defects in the installed Textual version."""

from __future__ import annotations

from textual.css.query import NoMatches
from textual.dom import NoScreen
from textual.events import Mount
from textual.widgets import Header

# `HeaderTitle` is not re-exported from `textual.widgets`; the override below
# needs the same class the base implementation queries for.
from textual.widgets._header import HeaderTitle


class SafeHeader(Header):
    """`Header` that tolerates its title watcher running before compose mounts.

    Textual's `Header._on_mount` registers title watchers with `init=True`, and
    their callback does `query_one(HeaderTitle)` guarded only against
    `NoScreen`. `HeaderTitle` is a child yielded by `Header.compose()`, so when
    the watcher runs before that child has mounted the query raises `NoMatches`
    — which escapes into the app's message pump and fails whatever is driving
    the app.

    It is timing-dependent: it surfaced on loaded CI runners and never
    reproduced locally, including under CPU contention. Verified against textual
    8.2.8, the latest release when this was written.

    Delete this once upstream catches `NoMatches` as well;
    `test_tui.py::TestSafeHeader` asserts the stock `Header` still has the
    defect, so it will fail and prompt the removal when that lands.
    """

    def _on_mount(self, event: Mount) -> None:
        # Textual dispatches a handler for every class in the MRO, so defining
        # `_on_mount` here does not replace the base one — it runs first, and
        # the unguarded original would still follow. `prevent_default` is what
        # actually suppresses it.
        event.prevent_default()

        async def set_title() -> None:
            try:
                self.query_one(HeaderTitle).update(self.format_title())
            except (NoScreen, NoMatches):
                pass

        self.watch(self.app, "title", set_title)
        self.watch(self.app, "sub_title", set_title)
        self.watch(self.screen, "title", set_title)
        self.watch(self.screen, "sub_title", set_title)
