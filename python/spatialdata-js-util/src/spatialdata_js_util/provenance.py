"""Version and checksum helpers recorded in output manifests."""

from __future__ import annotations

import hashlib
from importlib import metadata


def package_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def sha256(data: bytes | bytearray) -> str:
    return hashlib.sha256(data).hexdigest()
