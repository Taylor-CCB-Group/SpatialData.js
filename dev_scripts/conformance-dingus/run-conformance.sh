#!/usr/bin/env bash
# Run the OME-Zarr transformations conformance suite against the SpatialData.js
# dingus, fully self-contained via uv (no sibling checkout needed).
#
# The conformance suite is a pinned git dependency (see pyproject.toml). Its
# `cases/` are bundled into the installed package at site-packages/cases, so we
# resolve that path and pass it explicitly (the suite's "builtin cases" lookup
# does not work for its single-module install layout).
#
# Usage:
#   ./run-conformance.sh                 # run all cases
#   ./run-conformance.sh -v -p affine    # extra args are forwarded to oztc
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

uv sync --quiet
CASES="$(uv run python -c 'import os,sysconfig;print(os.path.join(sysconfig.get_paths()["purelib"],"cases"))')"
if [ ! -d "$CASES" ]; then
  echo "conformance cases not found at $CASES" >&2
  exit 1
fi
exec uv run oztc "$CASES" "$@" -- "$DIR/dingus.sh"
