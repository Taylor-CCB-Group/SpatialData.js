# Render Stack Groups Are a Tree, and Isolation Is Opt-In

**Status:** accepted
**Related:** [ADR 0001](0001-render-stack-owned-by-layers.md),
[Render Stack hierarchy plan](../plans/render-stack-hierarchy.md)

The Render Stack needs groups that combine their children with an opacity and a blend
mode, in the SpatialData viewer and in hosts with no SpatialData at all (MDV's abstract
scatterplot). v1 had a reserved `group` entry naming other top-level entries by id,
which nothing drew.

## Decision

1. **The stack is a tree.** A group holds its children as entries, and ids are unique
   across the tree. Host entries are full members: they can be group children, and
   inherit visibility like any other entry. v1 stacks upgrade on parse, and through
   `migrateRenderStack` for hosts that keep the stack as live state.
2. **Groups are pass-through unless isolated.** `blendMode` defaults to
   `pass-through`, and `isolate` to false. A pass-through group adds no layer: its
   visibility and opacity multiply into its children, which is exact only where they
   don't overlap. `isolate`, or any other blend mode, draws the children into their own
   target and composites that with the group's opacity and blend mode.
3. **Inherited state is applied where each leaf is built.** Spatial layer configs and
   resolved host layers carry their pass-through groups' opacity, so wrappers that do
   not forward `opacity` (Viv's, for one) still get it.
4. **One function turns a stack into deck layers.** `renderStackToDeckLayers` builds the
   groups for every host, so the SpatialData viewer and host-only charts cannot drift.
   A host routing layers to views by id tags the returned top-level layers; members
   inside a group are never routed.
5. **Picks name the entry, not the group.** Feature events carry the resolved
   `entryId`. Group members draw under group-scoped ids, so a layer moving into or out
   of a group never inherits deck state from its old place in the tree.
6. **Leaf blend modes are saved but not drawn yet.** Drawing them means overriding the
   `parameters` of layers we don't own, including Viv's on WebGL. Until that is settled,
   blending goes through groups.

## Consequences

- Code that reads `stack.entries` sees only the top level; it must walk the tree.
- Isolation costs one viewport-sized target per group and view, drawn only when its
  contents change. Pass-through costs nothing.
- Migration notices are returned values. A saved stack never fails to load because a
  v1 group named an entry that is gone.
