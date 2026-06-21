from __future__ import annotations

from typing import TYPE_CHECKING

from textual.app import App

from .models import WriterContext

if TYPE_CHECKING:
    from .screens import HomeScreen


class WriterApp(App[None]):
    CSS = """
    Screen {
        align: center middle;
    }

    .screen-title {
        width: 100%;
        content-align: center middle;
        padding: 1 0;
        text-style: bold;
    }

    .section-label {
        padding-top: 1;
        text-style: bold;
    }

    #command-list {
        width: 70;
        height: auto;
        max-height: 16;
        border: solid $accent;
        margin: 1 0;
    }

    #points-key-list {
        width: 70;
        height: auto;
        max-height: 12;
        border: solid $accent;
        margin: 1 0;
    }

    VerticalScroll {
        width: 80;
        height: 1fr;
        border: solid $primary;
        padding: 1 2;
    }

    Input {
        margin-bottom: 1;
    }

    #run-log {
        width: 90;
        height: 1fr;
        border: solid $accent;
        margin: 1 0;
    }

    #verify-table {
        width: 100%;
        height: auto;
        max-height: 14;
        margin: 1 0;
    }

    #confirm-message {
        width: 80;
        padding: 1 2;
        border: solid $warning;
        margin: 1 0;
    }

    Horizontal {
        width: auto;
        height: auto;
        align: center middle;
    }

    Button {
        margin: 0 1;
    }
    """

    BINDINGS = [("q", "quit", "Quit")]

    def __init__(self, *, initial_zarr: str | None = None) -> None:
        super().__init__()
        self.context = WriterContext(zarr_path=initial_zarr)
        self.home_screen: HomeScreen | None = None

    def on_mount(self) -> None:
        from .screens import HomeScreen

        self.home_screen = HomeScreen()
        self.install_screen(self.home_screen, "home")
        self.push_screen("home")

    def go_home(self) -> None:
        if self.home_screen is None:
            return
        self.switch_screen("home")


def run_tui(*, initial_zarr: str | None = None) -> None:
    app = WriterApp(initial_zarr=initial_zarr)
    app.run()
