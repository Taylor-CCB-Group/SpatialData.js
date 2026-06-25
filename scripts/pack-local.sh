#!/usr/bin/env bash
#
# pack-local.sh — build and pack all publishable @spatialdata/* packages (plus
# zarrextra) into local tarballs, and emit a pnpm.overrides block a consumer
# repo (e.g. MDV) can use to install them WITHOUT an npm release.
#
# Why tarballs instead of a workspace/source link:
#   A packed tarball exercises the REAL published surface — the built `dist`,
#   the package.json `exports` map, and the `files` allowlist. That is exactly
#   the surface where the integration bugs have been (missing exports, deep
#   `dist` reaches). A source link bypasses all of it and would hide them.
#
# Usage:
#   scripts/pack-local.sh [DEST_DIR]
#       DEST_DIR defaults to <repo>/.local-pack
#
# Then, in the consumer repo (MDV):
#   1. Merge .local-pack/overrides.json into "pnpm".."overrides" in package.json.
#   2. If a package you packed already contains a fix you were patching
#      (e.g. the new @spatialdata/vis exports), REMOVE the corresponding
#      patches/ entry and its pnpm.patchedDependencies key — otherwise pnpm will
#      try to apply the old patch to the new tarball.
#   3. pnpm install --force
#
# Re-running: re-pack + `pnpm install --force` picks up new content. pnpm hashes
# file: tarballs by content, so a changed tarball is detected. If you ever see a
# stale install, bump the package versions (a throwaway -local.N prerelease) and
# re-pack; overrides key by NAME so they keep resolving to the local tarballs.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$ROOT/.local-pack}"

# Publishable packages by directory (under packages/). Order is irrelevant for
# packing; listed roughly in dependency order for readability.
DIRS=(zarrextra avivatorish core layers react vis)

echo "==> cleaning $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"

echo "==> building all packages (pnpm -r build, excluding docs)"
pnpm -C "$ROOT" build

echo "==> packing tarballs to $DEST"
for d in "${DIRS[@]}"; do
  pnpm -C "$ROOT/packages/$d" pack --pack-destination "$DEST" >/dev/null
done

echo "==> packed:"
ls -1 "$DEST"/*.tgz

# Build overrides.json authoritatively: read the real package name from each
# tarball's package/package.json (handles scope correctly, no filename guessing).
echo "==> writing $DEST/overrides.json"
node - "$DEST" <<'NODE'
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const dest = process.argv[2];
const tgzs = fs.readdirSync(dest).filter((f) => f.endsWith(".tgz"));
const overrides = {};
for (const f of tgzs) {
  const full = path.join(dest, f);
  const pj = execSync(`tar -xzO -f ${JSON.stringify(full)} package/package.json`, {
    encoding: "utf8",
  });
  const name = JSON.parse(pj).name;
  overrides[name] = `file:${full}`;
}
const out = { pnpm: { overrides } };
fs.writeFileSync(path.join(dest, "overrides.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(overrides, null, 2));
NODE

cat <<EOF

==> done.
Next, in the consumer repo (e.g. MDV):
  1. Merge $DEST/overrides.json into "pnpm"."overrides" in package.json
  2. Remove any patches/ entry for a package you just packed with the fix baked in
  3. pnpm install --force
EOF
