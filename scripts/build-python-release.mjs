#!/usr/bin/env node
/**
 * Build the sdist and wheel of each PyPI package, and refuse to call the result
 * good unless both carry the gitignored files the package needs at runtime:
 *
 *   spatialdata-js-util  the vendored OpenJPH WASM (scripts/vendor-openjph-for-python.mjs)
 *   sdjs                 the bundled viewer (scripts/build-viewer-app.mjs)
 *
 * setuptools' package-data globs match nothing rather than failing when those
 * are absent, so `uv build` alone happily produces a release without them.
 *
 * Usage: build-python-release.mjs [--release] [package ...]   (default: every package)
 *
 * Output: python/<package>/dist/. It and setuptools' in-tree state (build/,
 * *.egg-info, whose SOURCES.txt feeds the sdist) are cleared first.
 *
 * `--release` additionally requires HEAD to carry the `<package>@<version>` tag
 * that `changeset publish` creates, so a PyPI upload is always built from the
 * commit that version names rather than from a later `main`. CI builds without it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = join(repoRoot, 'scripts');

const PACKAGES = {
  'spatialdata-js-util': {
    module: 'spatialdata_js_util',
    payload: 'codecs/vendor/openjph',
    prepare: (_payloadDir) => [join(scripts, 'vendor-openjph-for-python.mjs')],
    check: (files) => files.some((f) => f.endsWith('.wasm')) || 'no .wasm file',
  },
  sdjs: {
    module: 'sdjs',
    payload: 'app',
    prepare: (payloadDir) => [join(scripts, 'build-viewer-app.mjs'), payloadDir],
    check: (files) => files.some((f) => f.endsWith('/app/index.html')) || 'no app/index.html',
  },
};

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

function tagsAtHead() {
  return run('git', ['tag', '--points-at', 'HEAD'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  }).stdout.split('\n');
}

/** Builds one package; returns its problems, or [] if both artifacts are complete. */
function build(name, release) {
  const { module, payload, prepare, check } = PACKAGES[name];
  const pkgDir = join(repoRoot, 'python', name);
  const srcDir = join(pkgDir, 'src');
  const distDir = join(pkgDir, 'dist');
  const payloadDir = join(srcDir, module, payload);
  const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

  if (release && !tagsAtHead().includes(`${name}@${version}`)) {
    return [`HEAD is not tagged ${name}@${version}. Check out that tag (see RELEASE.md).`];
  }

  run(process.execPath, prepare(payloadDir));
  const payloadFiles = listFiles(payloadDir).map((path) =>
    relative(srcDir, path).split(sep).join('/')
  );
  const verdict = check(payloadFiles);
  if (verdict !== true) return [`${relative(repoRoot, payloadDir)}: ${verdict} after preparing it`];

  for (const stale of [distDir, join(pkgDir, 'build'), join(srcDir, `${module}.egg-info`)]) {
    rmSync(stale, { recursive: true, force: true });
  }
  run('uv', ['build', '--directory', pkgDir, '--out-dir', distDir]);

  const problems = [];
  for (const [label, path, prefix] of [
    ['wheel', join(distDir, `${module}-${version}-py3-none-any.whl`), ''],
    ['sdist', join(distDir, `${module}-${version}.tar.gz`), `${module}-${version}/src/`],
  ]) {
    if (!existsSync(path)) {
      problems.push(
        `${label}: expected ${relative(repoRoot, path)} (is pyproject.toml's version in sync with package.json?)`
      );
      continue;
    }
    const members = archiveMembers(path);
    const missing = payloadFiles.filter((file) => !members.has(prefix + file));
    if (missing.length > 0) problems.push(`${label}: missing ${missing.join(', ')}`);
  }
  if (problems.length === 0) {
    console.log(
      `\nBuilt ${name} ${version} with ${payloadFiles.length} ${payload} files in both artifacts.\n`
    );
  }
  return problems;
}

const args = process.argv.slice(2);
const release = args.includes('--release');
const names = args.filter((a) => a !== '--release');
const unknown = names.filter((n) => !(n in PACKAGES));
if (unknown.length > 0) {
  console.error(
    `Unknown package ${unknown.join(', ')}; expected ${Object.keys(PACKAGES).join(', ')}.`
  );
  process.exit(2);
}

let failed = false;
for (const name of names.length > 0 ? names : Object.keys(PACKAGES)) {
  const problems = build(name, release);
  if (problems.length > 0) {
    console.error(`\n${name} release build is incomplete:\n  ${problems.join('\n  ')}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
