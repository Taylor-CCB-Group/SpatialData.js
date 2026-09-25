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

## Writing

Applies to PR descriptions, changesets, commit messages, and docs
(including `docs/plans` and ADRs).

Say it once, in the right place, for the person who'll read it there.

- Lead with the point. Stop when the reader has what they need.
- Length scales with how surprising the change is, not how big the diff is.
- Don't restate what the reader already has: the diff, CI results, file lists.
- Raise alternatives only if a reader would plausibly ask. One line each.
- No headings, tables, or bold unless the text is long enough to need them.
- Say an explanation once, in the place it'll be needed longest: a code
  comment beats a doc, a doc beats a PR body. Link, don't copy.

**PR descriptions** are for a reviewer who'll read the diff. Give what
changed and why in a sentence or two, then bullets for anything needing
attention: risk, behaviour changes, uncertainty, follow-ups.

**Changesets** are for consumers reading a changelog. Say what changes for
someone using the package, and how to migrate if it breaks something.
Internal mechanics (build config, overrides, refactors) go in a code
comment or the commit, not here. Usually 1–3 sentences.

**Commit messages**: a subject line, and a body only for the why when the
subject isn't enough.

**Docs and plans**: state the current position. Cut history,
"we considered", and anything that belongs as a code comment. Revise
docs in place rather than appending.
