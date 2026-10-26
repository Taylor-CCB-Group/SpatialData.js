#!/usr/bin/env node
/**
 * Build the spatialdata-js-util sdist and wheel for PyPI, and refuse to call
 * the result good unless both carry the vendored OpenJPH WASM.
 *
 * The WASM is gitignored and only exists after
 * `scripts/vendor-openjph-for-python.mjs` has run. setuptools' package-data
 * globs match nothing rather than failing when it is absent, so `uv build`
 * alone happily produces a release whose HTJ2K encoder is missing.
 *
 * Output: python/spatialdata-js-util/dist/. It and setuptools' in-tree state
 * (build/, *.egg-info, whose SOURCES.txt feeds the sdist) are cleared first.
 *
 * `--release` additionally requires HEAD to carry the
 * `spatialdata-js-util@<version>` tag that `changeset publish` creates, so a
 * PyPI upload is always built from the commit that version names rather than
 * from a later `main`. CI builds without it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(repoRoot, 'python', 'spatialdata-js-util');
const distDir = join(pkgDir, 'dist');
const vendorDir = join(pkgDir, 'src', 'spatialdata_js_util', 'codecs', 'vendor', 'openjph');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
  return result;
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

/** Member names of a wheel or sdist, read with Python's stdlib. */
function archiveMembers(path) {
  const script = [
    'import json, sys, tarfile, zipfile',
    'p = sys.argv[1]',
    'names = zipfile.ZipFile(p).namelist() if p.endswith(".whl") else tarfile.open(p).getnames()',
    'print(json.dumps(names))',
  ].join('\n');
  const result = run('uv', ['run', '--no-project', 'python', '-I', '-c', script, path], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
  return new Set(JSON.parse(result.stdout));
}

const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

if (process.argv.includes('--release')) {
  const tag = `spatialdata-js-util@${version}`;
  const tags = run('git', ['tag', '--points-at', 'HEAD'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  }).stdout.split('\n');
  if (!tags.includes(tag)) {
    console.error(
      `HEAD is not tagged ${tag}. Check out that tag (see RELEASE.md) before building a release.`
    );
    process.exit(1);
  }
}

run(process.execPath, [join(repoRoot, 'scripts', 'vendor-openjph-for-python.mjs')]);

const vendored = listFiles(vendorDir).map((path) =>
  relative(join(pkgDir, 'src'), path).split(sep).join('/')
);
if (!vendored.some((path) => path.endsWith('.wasm'))) {
  throw new Error(`No .wasm file under ${vendorDir} after vendoring.`);
}

for (const stale of [
  distDir,
  join(pkgDir, 'build'),
  join(pkgDir, 'src', 'spatialdata_js_util.egg-info'),
]) {
  rmSync(stale, { recursive: true, force: true });
}
run('uv', ['build', '--directory', pkgDir, '--out-dir', distDir]);

const wheel = join(distDir, `spatialdata_js_util-${version}-py3-none-any.whl`);
const sdist = join(distDir, `spatialdata_js_util-${version}.tar.gz`);
const problems = [];

for (const [label, path, prefix] of [
  ['wheel', wheel, ''],
  ['sdist', sdist, `spatialdata_js_util-${version}/src/`],
]) {
  if (!existsSync(path)) {
    problems.push(
      `${label}: expected ${relative(repoRoot, path)} (is pyproject.toml's version in sync with package.json?)`
    );
    continue;
  }
  const members = archiveMembers(path);
  for (const file of vendored) {
    if (!members.has(prefix + file)) problems.push(`${label}: missing ${file}`);
  }
}

if (problems.length > 0) {
  console.error(`\nspatialdata-js-util release build is incomplete:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `\nBuilt spatialdata-js-util ${version} with ${vendored.length} vendored OpenJPH files in both artifacts.`
);
