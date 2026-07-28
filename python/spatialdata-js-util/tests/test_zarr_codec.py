"""The zarr shim: stores written with our codecs must open in plain zarr/spatialdata."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import zarr

from spatialdata_js_util.codecs import (
    CODEC_HTJ2K_OPENJPH,
    CODEC_JPEG2K,
    backend_report,
    htj2k_available,
)
from spatialdata_js_util.codecs.backends import (
    BACKEND_IMAGECODECS,
    BACKEND_OPENJPH_WASM,
    backend_passes_probe,
    probe_fixture,
)
from spatialdata_js_util.codecs.zarr_codec import Htj2kCodec, Jpeg2kCodec


def test_codecs_resolve_from_the_zarr_registry() -> None:
    """Entry-point registration must work without importing our modules first."""
    from zarr.registry import get_codec_class

    assert get_codec_class(CODEC_HTJ2K_OPENJPH) is Htj2kCodec
    assert get_codec_class(CODEC_JPEG2K) is Jpeg2kCodec


def test_codec_to_dict_matches_on_disk_metadata() -> None:
    assert Htj2kCodec().to_dict() == {
        "name": CODEC_HTJ2K_OPENJPH,
        "configuration": {},
    }


def test_codec_from_dict_tolerates_unknown_configuration() -> None:
    # Metadata written by another tool should still load rather than raise.
    assert isinstance(Htj2kCodec.from_dict({"configuration": {"unexpected": 1}}), Htj2kCodec)


@pytest.mark.skipif(not htj2k_available(), reason="No HTJ2K backend available.")
@pytest.mark.parametrize("codec_name", [CODEC_HTJ2K_OPENJPH, CODEC_JPEG2K])
def test_zarr_array_round_trips_through_the_codec(tmp_path: Path, codec_name: str) -> None:
    """A zarr array declaring our codec round-trips through zarr's own pipeline."""
    y, x = np.mgrid[0:64, 0:48]
    data = ((x * 5 + y * 3) % 4096).astype(np.uint16)

    store = tmp_path / f"{codec_name.replace('.', '_')}.zarr"
    array = zarr.create_array(
        store=str(store),
        shape=data.shape,
        chunks=(32, 24),
        dtype="uint16",
        serializer=Htj2kCodec() if codec_name == CODEC_HTJ2K_OPENJPH else Jpeg2kCodec(),
        compressors=None,
        zarr_format=3,
        overwrite=True,
    )
    array[:] = data

    reopened = zarr.open_array(str(store), mode="r")
    assert np.array_equal(np.asarray(reopened[:]), data)


@pytest.mark.skipif(not htj2k_available(), reason="No HTJ2K backend available.")
def test_codec_decodes_multi_component_chunks(tmp_path: Path) -> None:
    """Chunks with non-singleton leading axes decode component-wise, not flattened."""
    components, height, width = 3, 16, 12
    data = np.stack(
        [(np.arange(height * width, dtype=np.uint16).reshape(height, width) + c * 500)
         for c in range(components)]
    )

    store = tmp_path / "volume.zarr"
    array = zarr.create_array(
        store=str(store),
        shape=data.shape,
        chunks=data.shape,
        dtype="uint16",
        serializer=Htj2kCodec(),
        compressors=None,
        zarr_format=3,
        overwrite=True,
    )
    array[:] = data

    reopened = np.asarray(zarr.open_array(str(store), mode="r")[:])
    assert reopened.shape == data.shape
    # Each plane must survive independently — the failure mode documented in
    # docs/multi-component-codec-findings.md was every plane collapsing to plane 0.
    assert np.array_equal(reopened, data)


class TestBackendProbe:
    def test_probe_fixture_is_multi_component(self) -> None:
        codestream, expected = probe_fixture()
        assert len(codestream) > 0
        assert expected.ndim == 3
        assert expected.shape[0] > 1, "probe must exercise more than one component"
        # Distinct planes, so a decoder that replicates plane 0 cannot pass.
        assert not np.array_equal(expected[0], expected[1])

    def test_selected_backend_passes_the_probe(self) -> None:
        report = backend_report()
        selected = report["selected"]
        if selected is None:
            pytest.skip("No HTJ2K backend available.")
        if selected == BACKEND_IMAGECODECS:
            assert report["backends"][BACKEND_IMAGECODECS]["passes_multicomponent_probe"]

    def test_unknown_backend_never_passes(self) -> None:
        assert backend_passes_probe("not-a-real-backend") is False

    @pytest.mark.parametrize("name", [BACKEND_IMAGECODECS, BACKEND_OPENJPH_WASM])
    def test_available_backends_decode_our_codestream(self, name: str) -> None:
        """Whatever backends exist here must agree with the committed fixture."""
        from spatialdata_js_util.codecs.backends import _BACKENDS

        if not _BACKENDS[name].available():
            pytest.skip(f"{name} backend not available.")
        assert backend_passes_probe(name), (
            f"{name} is installed but decodes the multi-component probe incorrectly"
        )


class TestSpatialDataReadsOurStores:
    """The point of the shim: `spatialdata.read_zarr` opens what we write."""

    @staticmethod
    def _write_source(path: Path) -> np.ndarray:
        sd = pytest.importorskip("spatialdata")
        from spatialdata.models import Image2DModel

        y, x = np.mgrid[0:128, 0:96]
        plane = (((np.sin(x / 7.0) * np.cos(y / 5.0) + 1) * 6000)).astype(np.uint16)
        pixels = np.stack([plane, (plane // 3).astype(np.uint16)])
        sd.SpatialData(
            images={"morphology": Image2DModel.parse(pixels, dims=("c", "y", "x"))}
        ).write(path, overwrite=True)
        return pixels

    @pytest.mark.skipif(not htj2k_available(), reason="No HTJ2K backend available.")
    @pytest.mark.parametrize("codec_name", [CODEC_HTJ2K_OPENJPH, CODEC_JPEG2K])
    def test_lossless_recompressed_store_reads_back_exactly(
        self, tmp_path: Path, codec_name: str
    ) -> None:
        sd = pytest.importorskip("spatialdata")
        from spatialdata_js_util import recompress_spatialdata

        source = tmp_path / "source.zarr"
        pixels = self._write_source(source)

        dest = tmp_path / "recompressed.zarr"
        recompress_spatialdata(
            source,
            dest,
            codec=codec_name,
            preset="lossless",
            chunks="auto",
            overwrite=True,
        )

        read_back = np.asarray(sd.read_zarr(dest).images["morphology"].data.compute())
        assert np.array_equal(read_back, pixels)
