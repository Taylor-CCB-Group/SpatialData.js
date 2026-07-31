"""zarr-python v3 codec shim for the image codecs this package writes.

Registered through the ``zarr.codecs`` entry points declared in
``pyproject.toml``, so installing the distribution is enough to make
``zarr.open`` — and therefore ``spatialdata.read_zarr`` — decode stores written
by this package. No import or `register_codecs()` call is required; the explicit
`register_codecs()` below exists only for environments running from a source
tree without installed metadata.

The stores we write put a single array->bytes codec in the array metadata::

    "codecs": [{"name": "experimental.openjph_htj2k", "configuration": {}}]

so each chunk file is a bare codestream covering the whole chunk. Chunks have
singleton non-spatial axes (e.g. ``[1, 1, 1, 1024, 1024]``), which is why decode
reshapes the ``(components, y, x)`` result onto the full chunk shape.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import numpy as np
from zarr.abc.codec import ArrayBytesCodec
from zarr.core.buffer import Buffer, NDBuffer

from .encoding import decode_image_chunk, encode_image_chunk
from .names import CODEC_HTJ2K_LEGACY, CODEC_HTJ2K_OPENJPH, CODEC_JPEG2K

if TYPE_CHECKING:
    from zarr.core.array_spec import ArraySpec


def _spatial_dims(shape: tuple[int, ...]) -> tuple[int, int, int]:
    """Split a chunk shape into ``(components, height, width)``.

    Leading axes are collapsed into the component count, matching the planar
    ``(components, y, x)`` layout the encoders use.
    """
    if len(shape) < 2:
        raise ValueError(f"Image codec chunks must be at least 2D, got shape {shape}")
    height, width = int(shape[-2]), int(shape[-1])
    components = int(np.prod(shape[:-2])) if len(shape) > 2 else 1
    return components, height, width


@dataclass(frozen=True)
class _ImageCodec(ArrayBytesCodec):
    """Base for the array->bytes image codecs; subclasses set `codec_name`."""

    #: zarr v3 codec `name`; overridden per subclass.
    codec_name = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "_ImageCodec":
        # `configuration` is empty for these codecs but is accepted (and
        # ignored) so that metadata written by other tools still loads.
        return cls()

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.codec_name, "configuration": {}}

    def compute_encoded_size(self, input_byte_length: int, _chunk_spec: "ArraySpec") -> int:
        raise NotImplementedError(
            f"{self.codec_name} is a compressor; encoded size is not known ahead of time."
        )

    async def _decode_single(self, chunk_bytes: Buffer, chunk_spec: "ArraySpec") -> NDBuffer:
        components, height, width = _spatial_dims(tuple(chunk_spec.shape))
        decoded = decode_image_chunk(
            chunk_bytes.to_bytes(),
            self.codec_name,
            components=components,
            height=height,
            width=width,
        )
        dtype = chunk_spec.dtype.to_native_dtype()
        chunk = np.ascontiguousarray(decoded, dtype=dtype).reshape(tuple(chunk_spec.shape))
        return chunk_spec.prototype.nd_buffer.from_numpy_array(chunk)

    async def _encode_single(self, chunk_array: NDBuffer, chunk_spec: "ArraySpec") -> Buffer | None:
        components, height, width = _spatial_dims(tuple(chunk_spec.shape))
        volume = chunk_array.as_numpy_array().reshape(components, height, width)
        encoded = encode_image_chunk(volume, self.codec_name, self._encode_options())
        return chunk_spec.prototype.buffer.from_bytes(bytes(encoded))

    def _encode_options(self) -> dict[str, Any]:
        """Encode settings used when zarr writes through this codec.

        Lossless, because a codec instantiated from array metadata carries no
        quality configuration — the writer in `images.py` is the supported way to
        choose a lossy preset.
        """
        return {"reversible": True}


@dataclass(frozen=True)
class Htj2kCodec(_ImageCodec):
    """HTJ2K (High-Throughput JPEG 2000) via OpenJPH."""

    codec_name = CODEC_HTJ2K_OPENJPH


@dataclass(frozen=True)
class LegacyHtj2kCodec(_ImageCodec):
    """HTJ2K under the pre-OpenJPH label; decode-compatible with `Htj2kCodec`.

    Read-only by design. The label is registered so existing stores still open,
    but new chunks should carry the current name — writing more of them would
    spread a codec id we are trying to retire.
    """

    codec_name = CODEC_HTJ2K_LEGACY

    async def _encode_single(self, chunk_array: NDBuffer, chunk_spec: "ArraySpec") -> Buffer | None:
        raise NotImplementedError(
            f"{CODEC_HTJ2K_LEGACY} is a legacy label kept for reading existing stores; "
            f"write with {CODEC_HTJ2K_OPENJPH} instead."
        )


@dataclass(frozen=True)
class Jpeg2kCodec(_ImageCodec):
    """JPEG 2000 via `imagecodecs`."""

    codec_name = CODEC_JPEG2K

    def _encode_options(self) -> dict[str, Any]:
        return {"reversible": True}


CODEC_CLASSES: dict[str, type[_ImageCodec]] = {
    CODEC_HTJ2K_OPENJPH: Htj2kCodec,
    CODEC_HTJ2K_LEGACY: LegacyHtj2kCodec,
    CODEC_JPEG2K: Jpeg2kCodec,
}


def register_codecs() -> None:
    """Register the image codecs with zarr explicitly.

    Installing this distribution already registers them via entry points. Call
    this only when running from a source checkout with no installed metadata.
    """
    from zarr.registry import register_codec

    for name, codec_cls in CODEC_CLASSES.items():
        register_codec(name, codec_cls)
