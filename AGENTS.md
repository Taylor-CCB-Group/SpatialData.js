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

- Prefer behavioral tests over cache-key unit tests. If a change is
  performance-related, the test should observe runtime side effects (e.g.
  fetch counts), not internal cache hits.
- Worktrees share `.git` but not working state. Documents intended to outlive
  the current branch must land on `main`.
