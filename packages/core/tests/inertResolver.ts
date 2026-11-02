import type { EntryResources, ResourceResolver, SpatialEntryKind } from '../src/engine/index.js';

/**
 * A resolver that plans nothing and never loads. Fills the registry slots a spec
 * does not exercise, since `SpatialEntryStore` requires a resolver for every kind.
 */
export function inertResolver(kind: SpatialEntryKind): ResourceResolver {
  const snapshot: EntryResources = {
    entryId: 'inert',
    elementKey: 'inert',
    resources: {},
    notices: [],
    bounds: null,
    revision: 0,
  };
  return {
    kind,
    blockingResources: [],
    plan: () => [],
    load: async () => {},
    snapshot: () => snapshot,
    subscribe: () => () => {},
    getVersion: () => 0,
    retry: () => {},
    evict: () => {},
    dispose: () => {},
  };
}
