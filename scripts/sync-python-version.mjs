#!/usr/bin/env node
/**
 * Copy the Changesets-managed version of each PyPI package from its
 * package.json shim into pyproject.toml and the uv.lock files that record it.
 *
 * Runs as part of `pnpm version-packages`, which the release workflow runs
 * without uv installed — hence a text rewrite rather than `uv version`. Each
 * file is rewritten in place of the one line that holds the version, and the
 * script fails if a line is not found, so a layout change cannot leave a
 * Python version silently behind.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pythonDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'python');

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A uv.lock entry for `name`, which uv records with an editable `source`. */
const lockEntry = (name, source) =>
  new RegExp(
    `(^name = "${escapeRegExp(name)}"\\nversion = )"[^"]*"(?=\\nsource = \\{ editable = "${escapeRegExp(source)}" \\})`,
    'm'
  );

// The first `version = ` under [project]; nothing earlier in the file sets one.
const PYPROJECT = /(^\[project\]\n(?:.*\n)*?version = )"[^"]*"/m;

const PACKAGES = {
  'spatialdata-js-util': [
    ['spatialdata-js-util/pyproject.toml', PYPROJECT],
    ['spatialdata-js-util/uv.lock', lockEntry('spatialdata-js-util', '.')],
  ],
  sdjs: [
    ['sdjs/pyproject.toml', PYPROJECT],
    ['sdjs/uv.lock', lockEntry('sdjs', '.')],
    // spatialdata-js-util depends on sdjs from the sibling directory.
    ['spatialdata-js-util/uv.lock', lockEntry('sdjs', '../sdjs')],
  ],
};

for (const [name, files] of Object.entries(PACKAGES)) {
  const { version } = JSON.parse(readFileSync(join(pythonDir, name, 'package.json'), 'utf8'));
  for (const [file, pattern] of files) {
    const path = join(pythonDir, file);
    const source = readFileSync(path, 'utf8');
    if (!pattern.test(source)) {
      throw new Error(`python/${file}: could not find the ${name} version line to update.`);
    }
    const updated = source.replace(pattern, (_, head) => `${head}"${version}"`);
    if (updated !== source) {
      writeFileSync(path, updated);
      console.log(`python/${file}: ${name} version -> ${version}`);
    }
  }
}
