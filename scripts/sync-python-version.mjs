#!/usr/bin/env node
/**
 * Copy the Changesets-managed version of spatialdata-js-util from its
 * package.json shim into pyproject.toml and uv.lock.
 *
 * Runs as part of `pnpm version-packages`, which the release workflow runs
 * without uv installed — hence a text rewrite rather than `uv version`. Both
 * files are rewritten in place of the one line that holds the version, and
 * the script fails if either line is not found, so a layout change cannot
 * leave the Python version silently behind.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(repoRoot, 'python', 'spatialdata-js-util');

const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

function rewrite(file, pattern) {
  const path = join(pkgDir, file);
  const source = readFileSync(path, 'utf8');
  if (!pattern.test(source)) {
    throw new Error(`${file}: could not find the spatialdata-js-util version line to update.`);
  }
  const updated = source.replace(pattern, (_, head) => `${head}"${version}"`);
  if (updated !== source) {
    writeFileSync(path, updated);
    console.log(`${file}: spatialdata-js-util version -> ${version}`);
  }
}

// The first `version = ` under [project]; nothing earlier in the file sets one.
rewrite('pyproject.toml', /(^\[project\]\n(?:.*\n)*?version = )"[^"]*"/m);
// The project's own entry, which uv records with an editable source.
rewrite(
  'uv.lock',
  /(^name = "spatialdata-js-util"\nversion = )"[^"]*"(?=\nsource = \{ editable = "\." \})/m
);
