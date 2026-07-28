"""Drive the TUI headlessly through real commands.

These are not snapshot tests: each one fills the form the user would fill, presses
the buttons the user would press, and asserts the store on disk actually changed.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("textual")
anndata = pytest.importorskip("anndata")
sparse = pytest.importorskip("scipy.sparse")
sd = pytest.importorskip("spatialdata")

from textual.widgets import Button, Checkbox, Input, ListView  # noqa: E402

from spatialdata_js_util.tui.app import WriterApp  # noqa: E402
from spatialdata_js_util.tui.models import CommandId  # noqa: E402
from spatialdata_js_util.tui.screens import (  # noqa: E402
    ConfirmScreen,
    HomeScreen,
    RecompressImagesScreen,
    TablesToCscScreen,
    VerifyReportScreen,
)


def _store_with_table(path: Path) -> Path:
    from spatialdata.models import TableModel

    matrix = sparse.random(24, 6, density=0.4, format="csr", random_state=0, dtype=np.float32)
    adata = anndata.AnnData(X=matrix)
    adata.obs["region"] = "img"
    adata.obs["region"] = adata.obs["region"].astype("category")
    adata.obs["instance_id"] = np.arange(24)
    table = TableModel.parse(
        adata, region="img", region_key="region", instance_key="instance_id"
    )
    sd.SpatialData(tables={"table": table}).write(path, overwrite=True)
    return path


def _store_with_image(path: Path) -> np.ndarray:
    from spatialdata.models import Image2DModel

    y, x = np.mgrid[0:64, 0:48]
    pixels = np.stack([((x * 9 + y * 5) % 4096).astype(np.uint16)])
    sd.SpatialData(
        images={"morphology": Image2DModel.parse(pixels, dims=("c", "y", "x"))}
    ).write(path, overwrite=True)
    return pixels


async def _select(pilot, item_id: str) -> None:
    """Activate a home-menu entry by id."""
    menu = pilot.app.screen.query_one("#command-list", ListView)
    index = next(i for i, item in enumerate(menu.children) if item.id == item_id)
    menu.index = index
    await pilot.pause()
    menu.action_select_cursor()
    await pilot.pause()


async def _run_to_report(pilot, timeout: float = 120.0) -> VerifyReportScreen:
    """Wait for the report screen that RunScreen pushes when its worker finishes.

    Polled rather than keyed off `workers.wait_for_complete()`: the worker is
    started by RunScreen.on_mount, so waiting before the screen has mounted sees
    no workers and returns immediately.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if isinstance(pilot.app.screen, VerifyReportScreen):
            return pilot.app.screen
        await pilot.pause()
        await asyncio.sleep(0.05)
    raise AssertionError(
        f"no report screen after {timeout}s; stuck on {type(pilot.app.screen).__name__}"
    )


class TestHome:
    @pytest.mark.asyncio
    async def test_menu_covers_every_command_group(self) -> None:
        app = WriterApp()
        async with app.run_test() as pilot:
            await pilot.pause()
            assert isinstance(app.screen, HomeScreen)
            ids = [item.id for item in app.screen.query_one("#command-list", ListView).children]
            assert ids == [
                "cmd-recompress",
                "cmd-list-points",
                "cmd-morton-from-zarr",
                "cmd-morton-points",
                "cmd-multiscale-points",
                "cmd-index-permutations",
                "cmd-list-tables",
                "cmd-tables-to-csc",
                "cmd-codecs-info",
            ]

    @pytest.mark.asyncio
    async def test_codecs_info_reports_a_backend(self) -> None:
        app = WriterApp()
        async with app.run_test() as pilot:
            await pilot.pause()
            await _select(pilot, "cmd-codecs-info")
            report = await _run_to_report(pilot)
            assert report.error is None
            assert report.result is not None
            assert report.task_spec.command is CommandId.CODECS_INFO
            assert "backends" in report.result

    @pytest.mark.asyncio
    async def test_list_tables_prompts_for_a_store_then_lists(self, tmp_path: Path) -> None:
        store = _store_with_table(tmp_path / "s.zarr")
        app = WriterApp()
        async with app.run_test() as pilot:
            await pilot.pause()
            await _select(pilot, "cmd-list-tables")
            # No store in context yet, so the path prompt comes first.
            app.screen.query_one("#zarr-path", Input).value = str(store)
            await pilot.pause()
            app.screen.query_one("#continue", Button).press()
            report = await _run_to_report(pilot)
            assert report.error is None
            assert report.result is not None
            assert report.result["table_keys"] == ["table"]


class TestTablesToCsc:
    @pytest.mark.asyncio
    async def test_in_place_conversion_confirms_then_rewrites(self, tmp_path: Path) -> None:
        store = _store_with_table(tmp_path / "s.zarr")
        assert sd.read_zarr(store).tables["table"].X.format == "csr"

        app = WriterApp()
        async with app.run_test() as pilot:
            await pilot.pause()
            await _select(pilot, "cmd-tables-to-csc")
            assert isinstance(app.screen, TablesToCscScreen)

            app.screen.query_one("#source", Input).value = str(store)
            await pilot.pause()
            app.screen.query_one("#run", Button).press()
            await pilot.pause()

            # In-place writes must be confirmed before anything is touched.
            assert isinstance(app.screen, ConfirmScreen)
            assert str(store) in app.screen.task_spec.confirm_message
            app.screen.query_one("#confirm", Button).press()

            report = await _run_to_report(pilot)
            assert report.error is None, report.error

        assert sd.read_zarr(store).tables["table"].X.format == "csc"

    @pytest.mark.asyncio
    async def test_cancelling_the_confirm_leaves_the_store_alone(self, tmp_path: Path) -> None:
        store = _store_with_table(tmp_path / "s.zarr")

        app = WriterApp()
        async with app.run_test() as pilot:
            await pilot.pause()
            await _select(pilot, "cmd-tables-to-csc")
            app.screen.query_one("#source", Input).value = str(store)
            await pilot.pause()
            app.screen.query_one("#run", Button).press()
            await pilot.pause()
            assert isinstance(app.screen, ConfirmScreen)
            app.screen.query_one("#cancel", Button).press()
            await pilot.pause()

        assert sd.read_zarr(store).tables["table"].X.format == "csr"

    @pytest.mark.asyncio
    async def test_writing_to_a_destination_skips_the_confirm(self, tmp_path: Path) -> None:
        store = _store_with_table(tmp_path / "s.zarr")
        dest = tmp_path / "csc.zarr"

        app = WriterApp()
        async with app.run_test() as pilot:
            await pilot.pause()
            await _select(pilot, "cmd-tables-to-csc")
            app.screen.query_one("#source", Input).value = str(store)
            app.screen.query_one("#dest", Input).value = str(dest)
            await pilot.pause()
            app.screen.query_one("#run", Button).press()
            report = await _run_to_report(pilot)
            assert report.error is None, report.error

        assert sd.read_zarr(dest).tables["table"].X.format == "csc"
        assert sd.read_zarr(store).tables["table"].X.format == "csr"

    @pytest.mark.asyncio
    async def test_missing_source_is_reported_not_run(self, tmp_path: Path) -> None:
        app = WriterApp()
        async with app.run_test() as pilot:
            await pilot.pause()
            await _select(pilot, "cmd-tables-to-csc")
            app.screen.query_one("#source", Input).value = str(tmp_path / "nope.zarr")
            await pilot.pause()
            app.screen.query_one("#run", Button).press()
            await pilot.pause()
            # Stays on the form rather than launching a doomed run.
            assert isinstance(app.screen, TablesToCscScreen)


class TestRecompressImages:
    @pytest.mark.asyncio
    async def test_recompresses_losslessly_and_reads_back(self, tmp_path: Path) -> None:
        source = tmp_path / "src.zarr"
        pixels = _store_with_image(source)
        dest = tmp_path / "htj2k.zarr"

        app = WriterApp()
        async with app.run_test() as pilot:
            await pilot.pause()
            await _select(pilot, "cmd-recompress")
            assert isinstance(app.screen, RecompressImagesScreen)

            app.screen.query_one("#source", Input).value = str(source)
            app.screen.query_one("#dest", Input).value = str(dest)
            await pilot.pause()
            app.screen.query_one("#run", Button).press()

            report = await _run_to_report(pilot)
            assert report.error is None, report.error
            assert report.result is not None
            assert report.result["images"], "expected at least one recompressed raster"

        read_back = np.asarray(sd.read_zarr(dest).images["morphology"].data.compute())
        assert np.array_equal(read_back, pixels)

    @pytest.mark.asyncio
    async def test_quality_is_rejected_for_jpeg2000(self, tmp_path: Path) -> None:
        source = tmp_path / "src.zarr"
        _store_with_image(source)

        app = WriterApp()
        async with app.run_test() as pilot:
            await pilot.pause()
            await _select(pilot, "cmd-recompress")
            from textual.widgets import Select

            from spatialdata_js_util.codecs import CODEC_JPEG2K

            app.screen.query_one("#source", Input).value = str(source)
            app.screen.query_one("#dest", Input).value = str(tmp_path / "out.zarr")
            app.screen.query_one("#codec", Select).value = CODEC_JPEG2K
            app.screen.query_one("#quality", Input).value = "0.001"
            await pilot.pause()
            app.screen.query_one("#run", Button).press()
            await pilot.pause()
            # HTJ2K-only option on a JPEG 2000 run must not silently be ignored.
            assert isinstance(app.screen, RecompressImagesScreen)

    @pytest.mark.asyncio
    async def test_existing_destination_requires_the_overwrite_box(self, tmp_path: Path) -> None:
        source = tmp_path / "src.zarr"
        _store_with_image(source)
        dest = tmp_path / "out.zarr"
        dest.mkdir()

        app = WriterApp()
        async with app.run_test() as pilot:
            await pilot.pause()
            await _select(pilot, "cmd-recompress")
            app.screen.query_one("#source", Input).value = str(source)
            app.screen.query_one("#dest", Input).value = str(dest)
            await pilot.pause()
            app.screen.query_one("#run", Button).press()
            await pilot.pause()
            assert isinstance(app.screen, RecompressImagesScreen)

            # Ticking the box gets past the guard, onto the confirm screen.
            app.screen.query_one("#overwrite", Checkbox).value = True
            await pilot.pause()
            app.screen.query_one("#run", Button).press()
            await pilot.pause()
            assert isinstance(app.screen, ConfirmScreen)
