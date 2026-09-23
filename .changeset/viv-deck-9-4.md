---
"@spatialdata/avivatorish": minor
"@spatialdata/layers": minor
"@spatialdata/vis": minor
---

**Breaking:** the rendering stack moves to deck.gl 9.4, luma.gl 9.4 and Viv 0.23.

Viv 0.23 peers on `~9.4.0` across `@deck.gl/*` and `@luma.gl/*`, so the three move
together — a consumer cannot take this release while pinned to deck.gl 9.3.

| Package         | Before   | After    |
| --------------- | -------- | -------- |
| `@hms-dbmi/viv` | `0.22.x` | `0.23.0` |
| `deck.gl` / `@deck.gl/*` | `~9.3.7` | `~9.4.0` |
| `@luma.gl/*`    | `~9.3.6` | `~9.4.2` |

No source changes were needed: the layer, view and extension APIs we use are
unchanged across both bumps.

The `@loaders.gl/*` family is now pinned by an override. deck.gl and luma.gl both
reach it through caret ranges while the loaders.gl packages pin their own siblings
exactly, so on 9.4 pnpm resolved two variants of the family — which duplicated
`@deck.gl/layers` and, more importantly, the global loader registry in
`@loaders.gl/core`. deck.gl 9.3 happened to collapse to a single copy; 9.4 does not.
The override restores one copy of each. Bump those entries as a set.
