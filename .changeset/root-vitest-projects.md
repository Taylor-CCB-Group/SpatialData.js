---
'@spatialdata/core': patch
---

Run the package unit tests in CI.

`test:unit` was `vitest run --exclude tests/integration/**` with the glob
unquoted, so the shell expanded it before vitest saw it. `--exclude` took the
first match and the second became a positional filename filter, which meant the
command ran exactly one file — the integration test it was meant to exclude —
and no package unit test at all. CI reported that as a pass.

Quoting alone would have surfaced 49 failures: the root config declared a single
`node` environment for every file it collected, so the React hook tests in
`react`, `vis` and `avivatorish` failed with `document is not defined`. They pass
under `pnpm test`, which uses each package's own config.

The root config now declares one project per package, so each runs under its own
`vite.config.ts` and therefore its own environment, plus an `integration`
project for the root suite. `test:unit` and `test:integration` select by project
name rather than by glob. Both commands now agree with `pnpm test`: 788 tests
across 95 files, where CI had been running 20.
