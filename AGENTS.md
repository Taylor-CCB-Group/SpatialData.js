# Agents working in this repo

This file is a pointer for AI coding agents (Cursor, Claude, Codex, etc.)
joining work on this repository.

## Architecture notes — read before relevant changes

- **Layer rendering / prop flow / SpatialCanvas performance**: read
  [`docs/docs/vis/layer-prop-flow.mdx`](docs/docs/vis/layer-prop-flow.mdx)
  before adding or modifying layers, caches, or prop-routing inside
  `@spatialdata/vis` or `@spatialdata/layers`. It documents the principle
  ("layers are pure functions of props; identity stability is the producer's
  job; `updateTriggers` is the only declaration of structural-vs-cosmetic")
  and lists anti-patterns that have been tried and removed — do not
  reintroduce them.

## Working norms

- Use the Node.js and pnpm versions pinned in `package.json` under `volta`.
  If `node` or `pnpm` is missing or resolves to a different version, prefer
  Volta-managed commands (for example `$(volta which pnpm)` or `~/.volta/bin/pnpm`) rather
  than falling back to the Codex app bundled Node or the system Node.
- Prefer behavioral tests over cache-key unit tests. If a change is
  performance-related, the test should observe runtime side effects (e.g.
  fetch counts), not internal cache hits.
- Treat layers as independent views of spatial elements: it must be valid for
  multiple layer configs to represent the same underlying element with different
  visual properties, filters, or table-driven encodings.
- Avoid type assertions (`as ...`) in TypeScript when a library overload,
  local type guard, schema parser, discriminated union, or narrower API
  contract can express the same fact. If an assertion is unavoidable at an
  external boundary (for example an untyped WASM module or a TypeScript
  correlation limitation), keep it local and add a short comment explaining why
  the compiler cannot prove it.
- Worktrees share `.git` but not working state. Documents intended to outlive
  the current branch must land on `main`.
