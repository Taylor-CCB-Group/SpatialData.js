from __future__ import annotations

import json
import traceback
from pathlib import Path
from typing import Any

from textual import getters, work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.events import ScreenResume
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import Screen
from textual.widgets import (
    Button,
    Checkbox,
    DataTable,
    Footer,
    Header,
    Input,
    Label,
    ListItem,
    ListView,
    RichLog,
    Static,
)

from ..errors import WriterCommandError
from ..index_permutations import DEFAULT_CONDITIONS
from ..runners import (
    resolve_morton_from_zarr_output,
    run_list_points,
    run_morton_points,
    run_morton_points_from_zarr,
    run_multiscale_points,
    run_write_index_permutations,
)
from ..verify import (
    VerifyCheck,
    all_passed,
    verify_index_permutations_manifest,
    verify_morton_parquet,
    verify_multiscale_parquet,
)
from ..zarr import list_points_keys, read_points_element_attrs
from .app import WriterApp
from .models import CommandId, TaskSpec


def _positive_int(value: str, default: int) -> int:
    stripped = value.strip()
    if not stripped:
        return default
    parsed = int(stripped)
    if parsed <= 0:
        raise ValueError("value must be positive")
    return parsed


class WriterScreen(Screen[None]):
    app = getters.app(WriterApp)


class InputFormScreen(WriterScreen):
    """Form screen with Enter-to-advance/submit and Escape-to-back."""

    INPUT_ORDER: tuple[str, ...] = ()
    PRIMARY_BUTTON_ID: str = "run"

    BINDINGS = [
        Binding("escape", "go_back", "Back"),
    ]

    def on_mount(self) -> None:
        if self.INPUT_ORDER:
            self.query_one(f"#{self.INPUT_ORDER[0]}", Input).focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        input_id = event.input.id
        if input_id is None:
            self._press_primary()
            return
        if not self.INPUT_ORDER or input_id not in self.INPUT_ORDER:
            self._press_primary()
            return
        if input_id == self.INPUT_ORDER[-1]:
            self._press_primary()
            return
        next_index = self.INPUT_ORDER.index(input_id) + 1
        self.query_one(f"#{self.INPUT_ORDER[next_index]}", Input).focus()

    def action_go_back(self) -> None:
        self.app.pop_screen()

    def _press_primary(self) -> None:
        self.query_one(f"#{self.PRIMARY_BUTTON_ID}", Button).press()


class HomeScreen(WriterScreen):
    BINDINGS = [("q", "quit", "Quit")]

    def on_mount(self) -> None:
        self.query_one("#command-list", ListView).focus()

    def on_screen_resume(self, event: ScreenResume) -> None:
        self.refresh()
        self.query_one("#command-list", ListView).focus()

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(
            "SpatialData experimental writer — pick a command.",
            id="home-title",
        )
        yield ListView(
            ListItem(Label("List Points elements in a Zarr store"), id="cmd-list-points"),
            ListItem(Label("Morton-sort Points from Zarr"), id="cmd-morton-from-zarr"),
            ListItem(Label("Morton-sort CSV/Parquet file"), id="cmd-morton-points"),
            ListItem(Label("Write multiscale Points Parquet"), id="cmd-multiscale-points"),
            ListItem(
                Label("Write index permutations derivative store"),
                id="cmd-index-permutations",
            ),
            id="command-list",
        )
        yield Footer()

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        item_id = event.item.id or ""
        if item_id == "cmd-list-points":
            self._start_zarr_command(CommandId.LIST_POINTS)
        elif item_id == "cmd-morton-from-zarr":
            self._start_zarr_command(CommandId.MORTON_FROM_ZARR)
        elif item_id == "cmd-morton-points":
            self.app.push_screen(MortonFileScreen())
        elif item_id == "cmd-multiscale-points":
            self.app.push_screen(MultiscaleScreen())
        elif item_id == "cmd-index-permutations":
            self.app.push_screen(IndexPermutationsScreen())

    def _start_zarr_command(self, command: CommandId) -> None:
        if command == CommandId.LIST_POINTS:
            if self.app.context.zarr_path:
                self._run_list_points(self.app.context.zarr_path)
            else:
                self.app.push_screen(ZarrPathScreen(command))
            return
        if self.app.context.zarr_path:
            self.app.push_screen(PointsKeyScreen(command))
        else:
            self.app.push_screen(ZarrPathScreen(command))

    def _run_list_points(self, zarr: str) -> None:
        def runner() -> dict[str, Any]:
            return run_list_points(zarr)

        self.app.push_screen(
            RunScreen(
                TaskSpec(
                    command=CommandId.LIST_POINTS,
                    title="List Points",
                    runner=runner,
                    verify_kind="none",
                )
            )
        )


class ZarrPathScreen(InputFormScreen):
    INPUT_ORDER = ("zarr-path",)
    PRIMARY_BUTTON_ID = "continue"

    def __init__(self, command: CommandId) -> None:
        super().__init__()
        self.command = command

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("SpatialData Zarr store path", classes="screen-title")
        yield Input(placeholder="/path/to/store.zarr", id="zarr-path")
        with Horizontal():
            yield Button("Continue", variant="primary", id="continue")
            yield Button("Back", id="back")
        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.action_go_back()
            return
        self._continue()

    def _continue(self) -> None:
        path = self.query_one("#zarr-path", Input).value.strip()
        if not path:
            self.notify("Enter a Zarr store path.", severity="error")
            return
        resolved = Path(path)
        if not resolved.is_dir():
            self.notify(f"Not a directory: {path}", severity="error")
            return
        self.app.context.zarr_path = str(resolved)
        if self.command == CommandId.LIST_POINTS:
            self._run_list_points(path)
            return
        self.app.push_screen(PointsKeyScreen(self.command))

    def _run_list_points(self, zarr: str) -> None:
        def runner() -> dict[str, Any]:
            return run_list_points(zarr)

        self.app.push_screen(
            RunScreen(
                TaskSpec(
                    command=CommandId.LIST_POINTS,
                    title="List Points",
                    runner=runner,
                    verify_kind="none",
                )
            )
        )


class PointsKeyScreen(WriterScreen):
    BINDINGS = [
        Binding("escape", "go_back", "Back"),
    ]

    def __init__(self, command: CommandId) -> None:
        super().__init__()
        self.command = command

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("Select Points element", classes="screen-title")
        yield ListView(id="points-key-list")
        with Horizontal():
            yield Button("Continue", variant="primary", id="continue")
            yield Button("Back", id="back")
        yield Footer()

    def on_mount(self) -> None:
        zarr = self.app.context.zarr_path
        list_view = self.query_one("#points-key-list", ListView)
        if not zarr:
            return
        keys = list_points_keys(zarr)
        if not keys:
            list_view.mount(Static("No Points elements found."))
            return
        for key in keys:
            list_view.mount(ListItem(Label(key), id=f"key-{key}"))
        if len(keys) == 1:
            self.app.context.points_key = keys[0]
            list_view.index = 0
        list_view.focus()

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        item_id = event.item.id or ""
        if item_id.startswith("key-"):
            self.app.context.points_key = item_id.removeprefix("key-")
        self._continue()

    def action_go_back(self) -> None:
        self.app.pop_screen()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.action_go_back()
            return
        self._continue()

    def _continue(self) -> None:
        list_view = self.query_one("#points-key-list", ListView)
        if list_view.index is None:
            self.notify("Select a Points element.", severity="error")
            return
        item = list_view.children[list_view.index]
        item_id = item.id or ""
        if not item_id.startswith("key-"):
            self.notify("Select a Points element.", severity="error")
            return
        self.app.context.points_key = item_id.removeprefix("key-")
        if self.command == CommandId.MORTON_FROM_ZARR:
            self.app.push_screen(MortonFromZarrScreen())
        elif self.command == CommandId.INDEX_PERMUTATIONS:
            self.app.push_screen(IndexPermutationsScreen(from_zarr_context=True))


class MortonFromZarrScreen(InputFormScreen):
    INPUT_ORDER = ("feature-key", "row-group-size", "compression", "output-path")

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("Morton-sort Points from Zarr", classes="screen-title")
        with VerticalScroll():
            yield Label("Feature key column (optional)")
            yield Input(placeholder="feature_name", id="feature-key")
            yield Label("Row group size")
            yield Input(value="50000", id="row-group-size")
            yield Label("Compression")
            yield Input(value="zstd", id="compression")
            yield Label("Custom output path (optional)")
            yield Input(placeholder="leave empty for default", id="output-path")
            yield Checkbox("Write to points.experimental/", id="experimental")
        with Horizontal():
            yield Button("Run", variant="primary", id="run")
            yield Button("Back", id="back")
        yield Footer()

    def on_mount(self) -> None:
        zarr = self.app.context.zarr_path
        key = self.app.context.points_key
        if not zarr or not key:
            return
        try:
            attrs = read_points_element_attrs(zarr, key)
            feature_key = attrs.get("feature_key")
            if feature_key:
                self.query_one("#feature-key", Input).value = str(feature_key)
        except OSError:
            pass
        super().on_mount()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.action_go_back()
            return
        self._submit()

    def _submit(self) -> None:
        zarr = self.app.context.zarr_path
        key = self.app.context.points_key
        if not zarr or not key:
            self.notify("Missing Zarr context.", severity="error")
            return

        feature_key = self.query_one("#feature-key", Input).value.strip() or None
        output_text = self.query_one("#output-path", Input).value.strip() or None
        experimental = self.query_one("#experimental", Checkbox).value
        try:
            row_group_size = _positive_int(
                self.query_one("#row-group-size", Input).value, 50_000
            )
        except ValueError as exc:
            self.notify(str(exc), severity="error")
            return
        compression = self.query_one("#compression", Input).value.strip() or "zstd"

        _, resolved_output, in_place = resolve_morton_from_zarr_output(
            Path(zarr),
            key,
            output=output_text,
            experimental=experimental,
        )

        def runner() -> dict[str, Any]:
            return run_morton_points_from_zarr(
                zarr,
                points_key=key,
                experimental=experimental,
                output=output_text,
                feature_key=feature_key,
                row_group_size=row_group_size,
                compression=compression,
            )

        task = TaskSpec(
            command=CommandId.MORTON_FROM_ZARR,
            title="Morton-sort from Zarr",
            runner=runner,
            verify_kind="morton",
            verify_paths=[resolved_output],
            requires_confirm=in_place,
            confirm_message=(
                f"In-place overwrite of canonical Parquet:\n{resolved_output}\n\nProceed?"
            ),
        )
        self._launch_task(task)

    def _launch_task(self, task_spec: TaskSpec) -> None:
        if task_spec.requires_confirm:
            self.app.push_screen(ConfirmScreen(task_spec))
        else:
            self.app.push_screen(RunScreen(task_spec))


class MortonFileScreen(InputFormScreen):
    INPUT_ORDER = (
        "input-path",
        "output-path",
        "feature-key",
        "row-group-size",
        "compression",
    )

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("Morton-sort CSV/Parquet", classes="screen-title")
        with VerticalScroll():
            yield Label("Input path")
            yield Input(placeholder="input.csv or input.parquet", id="input-path")
            yield Label("Output path")
            yield Input(placeholder="output.parquet", id="output-path")
            yield Label("Feature key column (optional)")
            yield Input(placeholder="feature_name", id="feature-key")
            yield Label("Row group size")
            yield Input(value="50000", id="row-group-size")
            yield Label("Compression")
            yield Input(value="zstd", id="compression")
        with Horizontal():
            yield Button("Run", variant="primary", id="run")
            yield Button("Back", id="back")
        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.action_go_back()
            return
        self._submit()

    def _submit(self) -> None:
        input_path = self.query_one("#input-path", Input).value.strip()
        output_path = self.query_one("#output-path", Input).value.strip()
        if not input_path or not output_path:
            self.notify("Input and output paths are required.", severity="error")
            return
        feature_key = self.query_one("#feature-key", Input).value.strip() or None
        try:
            row_group_size = _positive_int(
                self.query_one("#row-group-size", Input).value, 50_000
            )
        except ValueError as exc:
            self.notify(str(exc), severity="error")
            return
        compression = self.query_one("#compression", Input).value.strip() or "zstd"

        def runner() -> dict[str, Any]:
            return run_morton_points(
                input_path,
                output_path,
                feature_key=feature_key,
                row_group_size=row_group_size,
                compression=compression,
            )

        self.app.push_screen(
            RunScreen(
                TaskSpec(
                    command=CommandId.MORTON_POINTS,
                    title="Morton-sort file",
                    runner=runner,
                    verify_kind="morton",
                    verify_paths=[Path(output_path)],
                )
            )
        )


class MultiscaleScreen(InputFormScreen):
    INPUT_ORDER = (
        "input-path",
        "output-path",
        "metadata-json",
        "row-group-size",
        "compression",
    )

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("Multiscale Points Parquet", classes="screen-title")
        with VerticalScroll():
            yield Label("Input path")
            yield Input(placeholder="input.parquet", id="input-path")
            yield Label("Output path")
            yield Input(placeholder="output.parquet", id="output-path")
            yield Label("Metadata JSON path (optional)")
            yield Input(placeholder="metadata.json", id="metadata-json")
            yield Label("Row group size")
            yield Input(value="50000", id="row-group-size")
            yield Label("Compression")
            yield Input(value="zstd", id="compression")
        with Horizontal():
            yield Button("Run", variant="primary", id="run")
            yield Button("Back", id="back")
        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.action_go_back()
            return
        self._submit()

    def _submit(self) -> None:
        input_path = self.query_one("#input-path", Input).value.strip()
        output_path = self.query_one("#output-path", Input).value.strip()
        if not input_path or not output_path:
            self.notify("Input and output paths are required.", severity="error")
            return
        metadata_json = self.query_one("#metadata-json", Input).value.strip() or None
        try:
            row_group_size = _positive_int(
                self.query_one("#row-group-size", Input).value, 50_000
            )
        except ValueError as exc:
            self.notify(str(exc), severity="error")
            return
        compression = self.query_one("#compression", Input).value.strip() or "zstd"

        def runner() -> dict[str, Any]:
            return run_multiscale_points(
                input_path,
                output_path,
                metadata_json=metadata_json,
                row_group_size=row_group_size,
                compression=compression,
            )

        self.app.push_screen(
            RunScreen(
                TaskSpec(
                    command=CommandId.MULTISCALE_POINTS,
                    title="Multiscale Points",
                    runner=runner,
                    verify_kind="multiscale",
                    verify_paths=[Path(output_path)],
                )
            )
        )


class IndexPermutationsScreen(InputFormScreen):
    INPUT_ORDER = (
        "source-zarr",
        "dest-zarr",
        "points-key",
        "max-rows",
        "row-group-size",
        "compression",
    )

    def __init__(self, *, from_zarr_context: bool = False) -> None:
        super().__init__()
        self.from_zarr_context = from_zarr_context

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("Write index permutations", classes="screen-title")
        with VerticalScroll():
            yield Label("Source Zarr")
            yield Input(id="source-zarr")
            yield Label("Destination Zarr")
            yield Input(id="dest-zarr")
            yield Label("Points key (optional if single element)")
            yield Input(id="points-key")
            yield Label("Max rows (optional)")
            yield Input(id="max-rows")
            yield Label("Row group size")
            yield Input(value="50000", id="row-group-size")
            yield Label("Compression")
            yield Input(value="zstd", id="compression")
            yield Checkbox("Overwrite destination if it exists", id="overwrite")
            yield Static("Conditions (default: all)", classes="section-label")
            with Vertical(id="conditions"):
                for condition in DEFAULT_CONDITIONS:
                    yield Checkbox(condition.id, value=True, id=f"cond-{condition.id}")
        with Horizontal():
            yield Button("Run", variant="primary", id="run")
            yield Button("Back", id="back")
        yield Footer()

    def on_mount(self) -> None:
        if self.app.context.zarr_path:
            self.query_one("#source-zarr", Input).value = self.app.context.zarr_path
        if self.from_zarr_context and self.app.context.points_key:
            self.query_one("#points-key", Input).value = self.app.context.points_key
        super().on_mount()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.action_go_back()
            return
        self._submit()

    def _submit(self) -> None:
        source = self.query_one("#source-zarr", Input).value.strip()
        dest = self.query_one("#dest-zarr", Input).value.strip()
        if not source or not dest:
            self.notify("Source and destination Zarr paths are required.", severity="error")
            return
        points_key = self.query_one("#points-key", Input).value.strip() or None
        max_rows_text = self.query_one("#max-rows", Input).value.strip()
        max_rows = None
        if max_rows_text:
            try:
                max_rows = _positive_int(max_rows_text, 0)
            except ValueError as exc:
                self.notify(str(exc), severity="error")
                return
        try:
            row_group_size = _positive_int(
                self.query_one("#row-group-size", Input).value, 50_000
            )
        except ValueError as exc:
            self.notify(str(exc), severity="error")
            return
        compression = self.query_one("#compression", Input).value.strip() or "zstd"
        overwrite = self.query_one("#overwrite", Checkbox).value
        selected = [
            condition.id
            for condition in DEFAULT_CONDITIONS
            if self.query_one(f"#cond-{condition.id}", Checkbox).value
        ]
        if not selected:
            self.notify("Select at least one condition.", severity="error")
            return
        all_selected = len(selected) == len(DEFAULT_CONDITIONS)
        condition_ids = None if all_selected else selected

        def runner() -> dict[str, Any]:
            return run_write_index_permutations(
                source,
                dest,
                points_key=points_key,
                max_rows=max_rows,
                condition_ids=condition_ids,
                overwrite=overwrite,
                row_group_size=row_group_size,
                compression=compression,
            )

        self.app.push_screen(
            RunScreen(
                TaskSpec(
                    command=CommandId.INDEX_PERMUTATIONS,
                    title="Index permutations",
                    runner=runner,
                    verify_kind="manifest",
                    verify_paths=[Path(dest)],
                )
            )
        )


class ConfirmScreen(WriterScreen):
    BINDINGS = [
        Binding("enter", "confirm", "Confirm overwrite"),
        Binding("escape", "cancel", "Cancel"),
    ]

    def __init__(self, task_spec: TaskSpec) -> None:
        super().__init__()
        self.task_spec = task_spec
        self._handled = False

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("Confirm in-place write", classes="screen-title")
        yield Static(self.task_spec.confirm_message, id="confirm-message")
        with Horizontal():
            yield Button("Confirm overwrite", variant="error", id="confirm")
            yield Button("Cancel", id="cancel")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#confirm", Button).focus()

    def action_confirm(self) -> None:
        self._confirm()

    def action_cancel(self) -> None:
        self._cancel()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        if event.button.id == "cancel":
            self._cancel()
            return
        self._confirm()

    def _confirm(self) -> None:
        if self._handled:
            return
        self._handled = True
        self.app.pop_screen()
        self.app.push_screen(RunScreen(self.task_spec))

    def _cancel(self) -> None:
        if self._handled:
            return
        self._handled = True
        self.app.pop_screen()


class RunScreen(WriterScreen):
    def __init__(self, task_spec: TaskSpec) -> None:
        super().__init__()
        self.task_spec = task_spec

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(self.task_spec.title, classes="screen-title")
        yield RichLog(id="run-log", highlight=True, markup=False)
        yield Footer()

    def on_mount(self) -> None:
        self.run_task()

    @work(thread=True)
    def run_task(self) -> None:
        log = self.query_one("#run-log", RichLog)
        result: dict[str, Any] | None = None
        error: str | None = None
        checks: list[VerifyCheck] = []
        try:
            self.app.call_from_thread(
                log.write, f"Running {self.task_spec.command.value}..."
            )
            result = self.task_spec.runner()
            self.app.call_from_thread(
                log.write, json.dumps(result, indent=2, sort_keys=True)
            )
            checks = self._verify()
        except WriterCommandError as exc:
            error = str(exc)
            self.app.call_from_thread(log.write, error)
        except Exception as exc:
            error = "".join(traceback.format_exception_only(exc)).strip()
            self.app.call_from_thread(log.write, error)

        self.app.call_from_thread(
            self.app.push_screen,
            VerifyReportScreen(
                task_spec=self.task_spec,
                result=result,
                checks=checks,
                error=error,
            ),
        )

    def _verify(self) -> list[VerifyCheck]:
        if self.task_spec.verify_kind == "none":
            return []
        if self.task_spec.verify_kind == "morton":
            checks: list[VerifyCheck] = []
            for path in self.task_spec.verify_paths:
                checks.extend(verify_morton_parquet(path))
            return checks
        if self.task_spec.verify_kind == "multiscale":
            checks = []
            for path in self.task_spec.verify_paths:
                checks.extend(verify_multiscale_parquet(path))
            return checks
        if self.task_spec.verify_kind == "manifest":
            checks = []
            for path in self.task_spec.verify_paths:
                checks.extend(verify_index_permutations_manifest(path))
            return checks
        return []


class VerifyReportScreen(WriterScreen):
    BINDINGS = [
        Binding("enter", "go_home", "Home"),
        Binding("escape", "go_home", "Home"),
    ]

    def __init__(
        self,
        *,
        task_spec: TaskSpec,
        result: dict[str, Any] | None,
        checks: list[VerifyCheck],
        error: str | None,
    ) -> None:
        super().__init__()
        self.task_spec = task_spec
        self.result = result
        self.checks = checks
        self.error = error
        self._handled = False

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("Run complete", classes="screen-title")
        with VerticalScroll():
            if self.error:
                yield Static(f"Error: {self.error}", id="error-text")
            elif self.result:
                if self.task_spec.command == CommandId.LIST_POINTS:
                    keys = self.result.get("points_keys", [])
                    yield Static(f"Points keys: {', '.join(keys) or '(none)'}")
                else:
                    rows = self.result.get("rows")
                    output = self.result.get("output")
                    if rows is not None:
                        yield Static(f"Rows: {rows}")
                    if output:
                        yield Static(f"Output: {output}")
            if self.checks:
                passed = all_passed(self.checks)
                status = "All checks passed" if passed else "Some checks failed"
                yield Static(f"Verification: {status}", id="verify-summary")
                table = DataTable(id="verify-table")
                table.add_columns("Check", "Status", "Detail")
                for check in self.checks:
                    table.add_row(
                        check.id,
                        "PASS" if check.passed else "FAIL",
                        check.detail,
                    )
                yield table
        with Horizontal():
            yield Button("Home", variant="primary", id="home")
            yield Button("Quit", id="quit")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#home", Button).focus()

    def action_go_home(self) -> None:
        self._go_home()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        if event.button.id == "home":
            self._go_home()
            return
        self._exit()

    def _go_home(self) -> None:
        if self._handled:
            return
        self._handled = True
        self.app.go_home()

    def _exit(self) -> None:
        if self._handled:
            return
        self._handled = True
        self.app.exit()
