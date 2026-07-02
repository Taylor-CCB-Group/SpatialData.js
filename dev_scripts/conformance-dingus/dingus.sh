#!/usr/bin/env bash
# Wrapper so the ome_zarr_transformations_conformance runner can call the dingus.
# Usage (from the conformance repo):
#   ./transformation_conformance.py ./cases -- \
#     /path/to/SpatialData.js/dev_scripts/conformance-dingus/dingus.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --experimental-strip-types "$DIR/dingus.ts" "$@"
