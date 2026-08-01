from __future__ import annotations

import json
import os
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
    Select,
    Static,
)

from ..codecs import CODEC_HTJ2K_OPENJPH, CODEC_JPEG2K
from ..pyramids import DEFAULT_MIN_SIZE as DEFAULT_PYRAMID_MIN_SIZE
from ..errors import WriterCommandError
from ..index_permutations import DEFAULT_CONDITIONS
from ..runners import (
    resolve_morton_from_zarr_output,
    run_list_points,
    run_list_tables,
    run_morton_points,
    run_morton_points_from_zarr,
    run_multiscale_points,
    run_tables_to_csc,
    run_write_index_permutations,
)
from ..verify import (
    VerifyCheck,
    all_passed,
    verify_index_permutations_manifest,
    verify_morton_parquet,
    verify_multiscale_parquet,
)
from ..store import list_points_keys, read_points_element_attrs
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
            "spatialdata-js-util — pick a command.",
            id="home-title",
        )
        yield ListView(
            ListItem(Label("IMAGES   Recompress rasters (JPEG 2000 / HTJ2K)"), id="cmd-recompress"),
            ListItem(Label("POINTS   List Points elements in a Zarr store"), id="cmd-list-points"),
            ListItem(Label("POINTS   Morton-sort Points from Zarr"), id="cmd-morton-from-zarr"),
            ListItem(Label("POINTS   Morton-sort CSV/Parquet file"), id="cmd-morton-points"),
            ListItem(Label("POINTS   Write multiscale Points Parquet"), id="cmd-multiscale-points"),
            ListItem(
                Label("POINTS   Write index permutations derivative store"),
                id="cmd-index-permutations",
            ),
            ListItem(Label("TABLES   List table elements in a Zarr store"), id="cmd-list-tables"),
            ListItem(Label("TABLES   Convert table matrices to CSC"), id="cmd-tables-to-csc"),
            ListItem(Label("CODECS   Show HTJ2K backend availability"), id="cmd-codecs-info"),
            id="command-list",
        )
        yield Footer()

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        item_id = event.item.id or ""
        if item_id == "cmd-recompress":
            self.app.push_screen(RecompressImagesScreen())
        elif item_id == "cmd-list-points":
            self._start_zarr_command(CommandId.LIST_POINTS)
        elif item_id == "cmd-morton-from-zarr":
            self._start_zarr_command(CommandId.MORTON_FROM_ZARR)
        elif item_id == "cmd-morton-points":
            self.app.push_screen(MortonFileScreen())
        elif item_id == "cmd-multiscale-points":
            self.app.push_screen(MultiscaleScreen())
        elif item_id == "cmd-index-permutations":
            self.app.push_screen(IndexPermutationsScreen())
        elif item_id == "cmd-list-tables":
            self._start_list_tables()
        elif item_id == "cmd-tables-to-csc":
            self.app.push_screen(TablesToCscScreen())
        elif item_id == "cmd-codecs-info":
            self.app.push_screen(RunScreen(codecs_info_task()))

    def _start_list_tables(self) -> None:
        zarr = self.app.context.zarr_path
        if not zarr:
            self.app.push_screen(ZarrPathScreen(CommandId.LIST_TABLES))
            return
        self.app.push_screen(RunScreen(list_tables_task(zarr)))

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
        if self.command == CommandId.LIST_TABLES:
            self.app.push_screen(RunScreen(list_tables_task(path)))
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
    INPUT_ORDER = ("feature-key", "row-group-size", "compression", "output-element")

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
            yield Label("Output Points element name (optional)")
            yield Input(placeholder="leave empty to overwrite selected element", id="output-element")
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
        output_key = self.query_one("#output-element", Input).value.strip() or None
        experimental = self.query_one("#experimental", Checkbox).value
        try:
            row_group_size = _positive_int(
                self.query_one("#row-group-size", Input).value, 50_000
            )
        except ValueError as exc:
            self.notify(str(exc), severity="error")
            return
        compression = self.query_one("#compression", Input).value.strip() or "zstd"

        try:
            output_spec = resolve_morton_from_zarr_output(
                Path(zarr),
                key,
                output_points_key=output_key,
                experimental=experimental,
            )
        except WriterCommandError as exc:
            self.notify(str(exc), severity="error")
            return

        target_exists = output_spec.output_parquet.exists()
        if (
            output_spec.collection == "points"
            and output_spec.output_points_key is not None
        ):
            target_exists = target_exists or (
                Path(zarr) / "points" / output_spec.output_points_key
            ).exists()
        requires_confirm = output_spec.in_place or target_exists

        def runner() -> dict[str, Any]:
            return run_morton_points_from_zarr(
                zarr,
                points_key=key,
                experimental=experimental,
                output_points_key=output_key,
                feature_key=feature_key,
                overwrite=requires_confirm,
                row_group_size=row_group_size,
                compression=compression,
            )

        if output_spec.in_place:
            confirm_message = (
                f"Overwrite selected Points element:\npoints/{key}\n\n"
                f"Parquet path:\n{output_spec.output_parquet}\n\nProceed?"
            )
        elif target_exists and output_spec.collection == "points":
            confirm_message = (
                f"Overwrite existing Points element:\n"
                f"points/{output_spec.output_points_key}\n\n"
                f"Parquet path:\n{output_spec.output_parquet}\n\nProceed?"
            )
        elif target_exists and output_spec.collection == "points.experimental":
            confirm_message = (
                f"Overwrite existing experimental Points artifact:\n"
                f"points.experimental/{output_spec.output_points_key}\n\n"
                f"Parquet path:\n{output_spec.output_parquet}\n\nProceed?"
            )
        else:
            confirm_message = ""

        task = TaskSpec(
            command=CommandId.MORTON_FROM_ZARR,
            title="Morton-sort from Zarr",
            runner=runner,
            verify_kind="morton",
            verify_paths=[output_spec.output_parquet],
            requires_confirm=requires_confirm,
            confirm_message=confirm_message,
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


def list_tables_task(zarr: str) -> TaskSpec:
    def runner() -> dict[str, Any]:
        return run_list_tables(zarr)

    return TaskSpec(
        command=CommandId.LIST_TABLES,
        title="List tables",
        runner=runner,
    )


def codecs_info_task() -> TaskSpec:
    def runner() -> dict[str, Any]:
        from ..codecs.backends import backend_report

        return backend_report()

    return TaskSpec(
        command=CommandId.CODECS_INFO,
        title="HTJ2K backends",
        runner=runner,
    )


class RecompressImagesScreen(InputFormScreen):
    """Recompress image rasters — the `images recompress` command."""

    INPUT_ORDER = (
        "source",
        "dest",
        "image-key",
        "quality",
        "chunks",
        "workers",
        "pyramid-levels",
        "pyramid-downscale",
        "pyramid-min-size",
    )

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("Recompress images", classes="screen-title")
        with VerticalScroll():
            yield Label("Source store")
            yield Input(
                value=self.app.context.zarr_path or "",
                placeholder="/path/to/input.zarr",
                id="source",
            )
            yield Label("Destination store")
            yield Input(placeholder="/path/to/output.zarr", id="dest")
            yield Label("Image key (blank = every image)")
            yield Input(placeholder="morphology_focus", id="image-key")
            yield Label("Codec")
            yield Select(
                [
                    ("HTJ2K (experimental.openjph_htj2k)", CODEC_HTJ2K_OPENJPH),
                    ("JPEG 2000 (imagecodecs_jpeg2k)", CODEC_JPEG2K),
                ],
                value=CODEC_HTJ2K_OPENJPH,
                allow_blank=False,
                id="codec",
            )
            yield Label("Preset")
            yield Select(
                [("lossless", "lossless"), ("balanced", "balanced"), ("small", "small")],
                value="lossless",
                allow_blank=False,
                id="preset",
            )
            yield Label(
                "HTJ2K quality — quantization step relative to the dtype's full range, "
                "lower = better (blank = use preset). Below one input LSB "
                "(1/256 for 8-bit, 1/65536 for 16-bit) it encodes larger than lossless."
            )
            yield Input(placeholder="0.0002", id="quality")
            yield Label("Chunks")
            yield Input(value="auto", placeholder="auto, or one integer per axis", id="chunks")
            yield Label("Workers")
            yield Input(value=str(os.cpu_count() or 1), id="workers")
            yield Checkbox("Write siblings instead of replacing images", id="sibling")
            yield Checkbox("Overwrite destination if it exists", id="overwrite")
            yield Static("Multiscale pyramid", classes="section-label")
            yield Checkbox(
                "Build a pyramid for images that have only one resolution level",
                id="pyramid",
            )
            yield Label("Levels ('auto' halves until the largest axis fits the size below)")
            yield Input(value="auto", id="pyramid-levels")
            yield Label("Downscale between levels")
            yield Input(value="2", id="pyramid-downscale")
            yield Label("Auto stops at this size (px)")
            yield Input(value=str(DEFAULT_PYRAMID_MIN_SIZE), id="pyramid-min-size")
            yield Checkbox("Rebuild images that already have a pyramid", id="pyramid-force")
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
        source = self.query_one("#source", Input).value.strip()
        dest = self.query_one("#dest", Input).value.strip()
        if not source or not dest:
            self.notify("Source and destination are required.", severity="error")
            return
        if not Path(source).is_dir():
            self.notify(f"Not a directory: {source}", severity="error")
            return

        codec = str(self.query_one("#codec", Select).value)
        preset = str(self.query_one("#preset", Select).value)
        quality_raw = self.query_one("#quality", Input).value.strip()
        quality: float | None = None
        if quality_raw:
            if codec != CODEC_HTJ2K_OPENJPH:
                self.notify("Quality applies to HTJ2K only.", severity="error")
                return
            try:
                quality = float(quality_raw)
            except ValueError:
                self.notify("Quality must be a number.", severity="error")
                return

        chunks_raw = self.query_one("#chunks", Input).value.strip() or "auto"
        if chunks_raw == "auto":
            chunks: Any = "auto"
        else:
            try:
                chunks = tuple(int(part) for part in chunks_raw.split())
            except ValueError:
                self.notify(
                    "Chunks must be 'auto' or space-separated integers.", severity="error"
                )
                return

        try:
            workers = _positive_int(self.query_one("#workers", Input).value, os.cpu_count() or 1)
        except ValueError as exc:
            self.notify(str(exc), severity="error")
            return

        levels_raw = self.query_one("#pyramid-levels", Input).value.strip() or "auto"
        if levels_raw == "auto":
            pyramid_levels: Any = "auto"
        else:
            try:
                pyramid_levels = _positive_int(levels_raw, 1)
            except ValueError:
                self.notify("Pyramid levels must be 'auto' or a positive integer.", severity="error")
                return
        try:
            pyramid_downscale = _positive_int(self.query_one("#pyramid-downscale", Input).value, 2)
            pyramid_min_size = _positive_int(
                self.query_one("#pyramid-min-size", Input).value, DEFAULT_PYRAMID_MIN_SIZE
            )
        except ValueError as exc:
            self.notify(str(exc), severity="error")
            return
        if pyramid_downscale < 2:
            self.notify("Pyramid downscale must be at least 2.", severity="error")
            return

        image_key = self.query_one("#image-key", Input).value.strip() or None
        sibling = self.query_one("#sibling", Checkbox).value
        overwrite = self.query_one("#overwrite", Checkbox).value
        pyramid = self.query_one("#pyramid", Checkbox).value
        pyramid_force = self.query_one("#pyramid-force", Checkbox).value
        self.app.context.zarr_path = source

        def runner() -> dict[str, Any]:
            from ..images import recompress_spatialdata

            return recompress_spatialdata(
                source,
                dest,
                image_key=image_key,
                codec=codec,
                # An explicit quality overrides the preset, so don't send both.
                preset=None if quality is not None else preset,
                chunks=chunks,
                quality=quality,
                sibling=sibling,
                overwrite=overwrite,
                workers=workers,
                pyramid=pyramid or pyramid_force,
                pyramid_levels=pyramid_levels,
                pyramid_downscale=pyramid_downscale,
                pyramid_min_size=pyramid_min_size,
                pyramid_force=pyramid_force,
            ).manifest

        dest_exists = Path(dest).exists()
        task = TaskSpec(
            command=CommandId.RECOMPRESS,
            title="Recompress images",
            runner=runner,
            requires_confirm=dest_exists,
            confirm_message=(
                f"Destination already exists and will be replaced:\n{dest}\n\nProceed?"
            ),
        )
        if dest_exists and not overwrite:
            self.notify(
                "Destination exists — tick 'Overwrite destination' to replace it.",
                severity="error",
            )
            return
        self.app.push_screen(ConfirmScreen(task) if task.requires_confirm else RunScreen(task))


class TablesToCscScreen(InputFormScreen):
    """Convert table matrices to CSC — the `tables to-csc` command."""

    INPUT_ORDER = ("source", "dest", "tables")

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("Convert tables to CSC", classes="screen-title")
        with VerticalScroll():
            yield Static(
                "CSC makes reading one variable (gene) a single contiguous range read "
                "instead of a scan of every row. Values are unchanged.",
                classes="section-label",
            )
            yield Label("Source store")
            yield Input(
                value=self.app.context.zarr_path or "",
                placeholder="/path/to/store.zarr",
                id="source",
            )
            yield Label("Destination store (blank = rewrite source in place)")
            yield Input(placeholder="/path/to/output.zarr", id="dest")
            yield Label("Table keys, comma-separated (blank = all tables)")
            yield Input(placeholder="table", id="tables")
            yield Checkbox("Convert named layers too", value=True, id="layers")
            yield Checkbox("Also convert dense matrices (may increase size)", id="densify")
            yield Checkbox("Overwrite destination if it exists", id="overwrite")
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
        source = self.query_one("#source", Input).value.strip()
        if not source:
            self.notify("Source store is required.", severity="error")
            return
        if not Path(source).is_dir():
            self.notify(f"Not a directory: {source}", severity="error")
            return

        dest = self.query_one("#dest", Input).value.strip() or None
        tables_raw = self.query_one("#tables", Input).value.strip()
        tables = [key.strip() for key in tables_raw.split(",") if key.strip()] or None
        layers = self.query_one("#layers", Checkbox).value
        densify = self.query_one("#densify", Checkbox).value
        overwrite = self.query_one("#overwrite", Checkbox).value
        self.app.context.zarr_path = source

        def runner() -> dict[str, Any]:
            return run_tables_to_csc(
                source,
                dest,
                tables=tables,
                layers=layers,
                densify=densify,
                overwrite=overwrite,
            )

        in_place = dest is None
        dest_exists = dest is not None and Path(dest).exists()
        if dest_exists and not overwrite:
            # The run would fail on this deep inside the conversion; say so while
            # the form is still on screen and editable.
            self.notify(
                f"Destination already exists: {dest}\nTick overwrite to replace it.",
                severity="error",
            )
            return

        scope = "All tables" if tables is None else "Tables: " + ", ".join(tables)
        if in_place:
            confirm_message = (
                f"Rewrite table matrices in place:\n{source}\n\n{scope}\n\n"
                "Values are preserved; only the sparse layout changes. Proceed?"
            )
        else:
            confirm_message = (
                f"Replace the existing store:\n{dest}\n\n{scope}\n\n"
                "Its current contents are deleted before the copy. Proceed?"
            )

        # Anything that destroys existing data is confirmed, whether that is the
        # source (in place) or the destination (overwrite).
        needs_confirm = in_place or dest_exists
        task = TaskSpec(
            command=CommandId.TABLES_TO_CSC,
            title="Tables to CSC",
            runner=runner,
            requires_confirm=needs_confirm,
            confirm_message=confirm_message,
        )
        self.app.push_screen(ConfirmScreen(task) if needs_confirm else RunScreen(task))


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
                yield from self._summary_lines(self.result)
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

    def _summary_lines(self, result: dict[str, Any]) -> ComposeResult:
        """Render the headline facts per command; the full JSON is on the run log."""
        command = self.task_spec.command
        if command == CommandId.LIST_POINTS:
            keys = result.get("points_keys", [])
            yield Static(f"Points keys: {', '.join(keys) or '(none)'}")
        elif command == CommandId.LIST_TABLES:
            keys = result.get("table_keys", [])
            yield Static(f"Table keys: {', '.join(keys) or '(none)'}")
        elif command == CommandId.CODECS_INFO:
            yield Static(f"Selected backend: {result.get('selected') or '(none available)'}")
            for name, info in (result.get("backends") or {}).items():
                available = "available" if info.get("available") else "not available"
                probe = "probe OK" if info.get("passes_multicomponent_probe") else "probe FAILED"
                yield Static(f"  {name}: {available}, {probe}")
        elif command == CommandId.RECOMPRESS:
            images = result.get("images") or []
            yield Static(f"Output: {result.get('output')}")
            yield Static(f"Rasters recompressed: {len(images)}")
            total = sum(int(image.get("encoded_bytes") or 0) for image in images)
            if total:
                yield Static(f"Encoded bytes: {total:,}")
            backend = (result.get("htj2k") or {}).get("selected")
            if backend:
                yield Static(f"HTJ2K backend: {backend}")
            for entry in result.get("pyramids") or []:
                if entry.get("action") == "rebuilt":
                    built = ", ".join(entry.get("levels") or [])
                    yield Static(f"  pyramid {entry['path']}: {built}")
                else:
                    yield Static(f"  pyramid {entry['path']}: skipped ({entry.get('reason')})")
        elif command == CommandId.TABLES_TO_CSC:
            yield Static(f"Output: {result.get('output')}")
            for table in result.get("tables") or []:
                matrices = ", ".join(
                    f"{key} {value}" for key, value in (table.get("matrices") or {}).items()
                )
                yield Static(f"  {table.get('path')}: {matrices or '(no matrices)'}")
        else:
            rows = result.get("rows")
            output = result.get("output")
            if rows is not None:
                yield Static(f"Rows: {rows}")
            if output:
                yield Static(f"Output: {output}")

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
