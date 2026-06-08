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
- Use the npm `next` dist-tag for the MDV-targeted alpha line. Do not publish
  this prerelease as `latest`.

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
   pnpm --filter zarrextra publish --dry-run --no-git-checks --tag next
   pnpm --filter @spatialdata/core publish --dry-run --no-git-checks --tag next
   pnpm --filter @spatialdata/vis publish --dry-run --no-git-checks --tag next
   ```

8. Confirm the generated `@spatialdata/core` package manifest depends on
   `zarrextra`, not `@spatialdata/zarrextra`:

   ```bash
   pnpm --filter @spatialdata/core pack --pack-destination /tmp --json
   tar -xOf /tmp/spatialdata-core-*.tgz package/package.json
   ```

9. Publish manually with the `next` dist-tag:

   ```bash
   pnpm publish:next
   ```

10. Smoke-test in MDV:

    ```bash
    pnpm add @spatialdata/vis@next
    ```

## If something looks wrong

- Do not publish.
- Delete local tarballs or build outputs if needed, rebuild, and repeat the
  dry-runs.
- If a bad version is published, prefer deprecating it on npm and publishing a
  fixed version. Unpublishing should be a last resort because it can disrupt
  downstream installs.
