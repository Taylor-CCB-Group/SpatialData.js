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
   ```

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

10. Smoke-test in MDV:

    ```bash
    pnpm add @spatialdata/vis
    ```

## If something looks wrong

- Do not publish.
- Delete local tarballs or build outputs if needed, rebuild, and repeat the
  dry-runs.
- If a bad version is published, prefer deprecating it on npm and publishing a
  fixed version. Unpublishing should be a last resort because it can disrupt
  downstream installs.
