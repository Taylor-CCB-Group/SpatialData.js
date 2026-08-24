---
"@spatialdata/layers": patch
---

Points: stop the tile debug overlay's `aborted` state looking like an error.

`aborted` was a dusty red — `[180, 80, 80]` against `error`'s `[220, 60, 60]` — so a
cancelled request was indistinguishable at a glance from a failed one. It is a violet
now: an unoccupied hue (the palette otherwise runs neutral / amber / green / blue /
red) at an alpha near `pending`'s, because a request the viewport moved on from is the
least interesting thing on the overlay. **Red now means exactly one thing.**

`error` is also marked out by weight, via a new `tileDebugStatusLineWidth`: a 4px
outline against everyone else's 2px. `loaded` green against `error` red is the classic
red-green pair, so hue alone does not carry that difference for everyone, and neither
does opacity — `loading` is deliberately fully opaque too, so an in-flight tile stays
legible.

An abort also no longer sets `errorMessage`. It was the literal string `'aborted'`,
which the tooltip rendered as a row labelled **error** reading *aborted* — the same
red-herring as the colour, in words. The status already carries it.

The tests assert the properties rather than the exact channels — error is the only
status that reads as red, every outline is distinct, error is uniquely the widest —
so retuning the palette later does not mean rewriting them.
