# Release Process

SpatialData.js uses Changesets for versioning and release notes, but npm
publishing is intentionally manual for now.

## Security posture

- Do not add `NPM_TOKEN` or other npm publish credentials to GitHub repository
  secrets.
- GitHub Actions may create the Changesets version PR, but it must not publish
  packages to npm.
- Publish only from a clean local checkout after reviewing the final diff and
  generated package contents.
- Publish to the default `latest` dist-tag. The library is still alpha, but
  versions follow normal semver and `latest` should always point at the newest
  published version of each package.
- Reserve the `next` dist-tag for genuine prereleases (e.g. release candidates
  ahead of a `latest` cut). Never leave `next` pointing at a version older than
  `latest` — if you are not actively shipping a prerelease, do not touch `next`.

## Package versioning

- The `@spatialdata/*` packages are fixed together by Changesets:
  - `@spatialdata/core`
  - `@spatialdata/react`
  - `@spatialdata/layers`
  - `@spatialdata/avivatorish`
  - `@spatialdata/vis`
- `zarrextra` is published outside the `@spatialdata/*` namespace.
- `zarrextra` participates in the first prerelease because `@spatialdata/core`
  depends on it, but it is not fixed to the `@spatialdata/*` version train for
  future releases.
- The PyPI packages `spatialdata-js-util` and `sdjs` (in `python/`) are
  versioned by Changesets through a private `package.json` shim in each.
  `pnpm version-packages` copies the versions into `pyproject.toml` and
  `uv.lock`. `changeset publish` does not publish them, but tags each new
  version `<package>@<version>`, and PyPI releases are built from that tag; see
  [Python packages](#python-packages-pypi).
- `sdjs` is fixed to `@spatialdata/cli`, its npm twin: the same `sdjs serve`
  command, so both carry the same version.

## Dist-tags

Early releases mixed the `next` and `latest` dist-tags inconsistently, which
left `next` pointing at stale versions (for example `zarrextra@next` resolved to
an _older_ version than `zarrextra@latest`). Going forward, publish to `latest`
only (see the normal flow) and treat `next` as opt-in for real prereleases.

To inspect the current tags:

```bash
npm dist-tag ls zarrextra
npm dist-tag ls @spatialdata/vis
```

If a `next` tag is stale and you are not shipping a prerelease, repoint it at the
current `latest` version (or leave it alone — `latest` is what installs resolve
to by default):

```bash
npm dist-tag add zarrextra@<latest-version> next
```

## Normal flow

1. Add one or more Changesets for user-facing package changes:

   ```bash
   pnpm changeset
   ```

2. Merge the feature PR.

3. Let the `Version Packages` GitHub Action open the version PR, or run it
   locally:

   ```bash
   pnpm version-packages
   ```

   Since Changesets v3, `changeset version` exits 1 when there is nothing to
   release, rather than exiting 0 having done nothing. That is only a surprise
   when running it by hand: the GitHub Action checks for pending changesets
   first and skips the version script when there are none. Locally it also
   needs `GITHUB_TOKEN` set (for example `GITHUB_TOKEN=$(gh auth token)`),
   because the changelog generator looks up PR authors.

4. Review the version PR carefully:

   - package versions
   - changelog entries
   - generated dependency versions
   - any unexpected files

5. Merge the version PR.

6. From a clean local checkout of the merged commit on `main`, verify:

   ```bash
   pnpm install --frozen-lockfile
   pnpm build
   pnpm -r --filter @spatialdata/vis test
   pnpm docs:build
   ```

7. Dry-run the important publish targets:

   ```bash
   pnpm --filter zarrextra publish --dry-run --no-git-checks
   pnpm --filter @spatialdata/core publish --dry-run --no-git-checks
   pnpm --filter @spatialdata/vis publish --dry-run --no-git-checks
   pnpm --filter @spatialdata/cli publish --dry-run --no-git-checks
   ```

   The `@spatialdata/cli` file list should include `app/index.html`, the bundled
   viewer that `pnpm build` puts there.

8. Confirm the generated `@spatialdata/core` package manifest depends on
   `zarrextra`, not `@spatialdata/zarrextra`:

   ```bash
   pnpm --filter @spatialdata/core pack --pack-destination /tmp --json
   tar -xOf /tmp/spatialdata-core-*.tgz package/package.json
   ```

9. Publish manually to the default `latest` dist-tag:

   ```bash
   pnpm publish:latest
   ```

   Note: run the `publish:latest` script, not `pnpm publish`. `publish` is a
   built-in pnpm command that would try to publish the private repo-root package
   (and fail with `EPRIVATE`) instead of running Changesets.

   For a genuine prerelease (not the normal flow), publish to `next` instead:

   ```bash
   pnpm publish:next
   ```

   Either way, push the git tags it created:

   ```bash
   git push origin --tags
   ```

10. Smoke-test in MDV:

    ```bash
    pnpm add @spatialdata/vis
    ```

## Python packages (PyPI)

Publishing is manual. The merged version PR has already set each version in its
shim, `pyproject.toml` and `uv.lock`; do not rerun `pnpm version-packages`.

`spatialdata-js-util` depends on `sdjs`, so when both have a new version,
publish `sdjs` first: the util's smoke test in step 3 resolves `sdjs` from PyPI.

For each package with a new version:

1. Tag the version. Step 9 of the normal flow does this. If the version PR
   changed no npm package, create and push the tag without publishing:

   ```bash
   pnpm changeset git-tag
   git push origin --tags
   ```

2. Build both artifacts from that tag:

   ```bash
   git checkout <package>@<version>
   pnpm build:python --release <package>
   ```

   This bundles the package's gitignored runtime files (the OpenJPH WASM for
   `spatialdata-js-util`, the viewer for `sdjs`), builds into
   `python/<package>/dist/`, and fails unless HEAD carries the tag and the
   wheel and sdist both contain every one of those files. Do not publish the
   output of a bare `uv build`: it succeeds without them.

3. Smoke-test the wheel in a throwaway environment:

   ```bash
   uv run --isolated --no-project --with python/<package>/dist/*.whl <package> --help
   ```

4. Publish, with a PyPI API token scoped to that package:

   ```bash
   uv publish python/<package>/dist/*
   ```

   `uv publish` prompts for the token, or reads `UV_PUBLISH_TOKEN`.
   PyPI never accepts a version twice, even after deletion, so a bad release
   is fixed by yanking it and publishing the next version.

   A package's first upload is what registers its name on PyPI, and a token
   can only be scoped to a project that exists, so that upload needs an
   account-wide token. Replace it with a project-scoped one afterwards.

## Release tooling

The `Version Packages` workflow and the Changesets CLI are a matched pair:
`changesets/action@v2` requires `@changesets/cli` v3 and refuses to run against
v2, and its input names differ from v1's. Neither major can move on its own.

Nothing on a pull request runs `release.yml` — its only trigger is `push: main`
— so a change to it is green by default, which is how a Dependabot bump of the
action to v2 reached main against a v2 CLI. The `release-toolchain` job in
`Workflow Lint` closes that gap by checking the pairing statically:

```bash
pnpm lint:release-toolchain
```

Taking a new major of `changesets/action` means updating the `ACTION_MAJORS`
table in `scripts/check-release-toolchain.mjs` alongside the workflow and the
CLI dependency; the check fails on an unrecognised major rather than assuming
it is fine.

## If something looks wrong

- Do not publish.
- Delete local tarballs or build outputs if needed, rebuild, and repeat the
  dry-runs.
- If a bad version is published, prefer deprecating it on npm and publishing a
  fixed version. Unpublishing should be a last resort because it can disrupt
  downstream installs.
