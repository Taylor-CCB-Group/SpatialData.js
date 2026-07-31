---
'@spatialdata/layers': minor
'@spatialdata/vis': minor
---

Let `fillColorByColumn` carry a colour scheme, and default categorical colouring to the
unbounded OkLab scheme.

`fillColorByColumn` on both shapes and labels layers now takes `categoricalPalette`
(`'oklab'`, or your own RGB list, which cycles) and `numericRamp`. Both are
JSON-serializable, so they survive a saved Render Stack.

**Behaviour change:** the categorical default is now `'oklab'` — the same golden-angle
OKLCh scheme `@spatialdata/layers` already used for points colour-by-feature. The previous
six-colour palette cycled, so a column with more than six categories silently drew two
categories in the same colour; the OkLab scheme is a pure function of the category index
and has no length. Pass an explicit RGB list to pin specific colours.
