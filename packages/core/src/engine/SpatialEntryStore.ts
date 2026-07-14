import type { SpatialEntryKind } from './errors.js';
import type { EntryResources, ResolveContext, ResolveTask, ResourceResolver } from './resolver.js';

/**
 * The reconcile loop over a Render Stack's Spatial Entries.
 *
 * This is what the 400-line `Promise.all` switch in `useLayerData` collapses into.
 * It knows nothing about any kind: it holds a `Record<kind, ResourceResolver>` and
 * calls `plan` → `load` → `snapshot` on whichever resolver a context names.
 *
 * That opacity is the point. A resolver's *package* is an implementation detail —
 * `PointsResolver` and `ShapesResolver` live in `core`, `ImagesResolver` and
 * `LabelsResolver` in `vis` — and the store must never be able to tell, because
 * the moment it can, "images is special" becomes representable and the interface
 * stops being one interface. If a `vis`-resident resolver needs something this
 * loop doesn't offer, that is a signal about the interface, not a licence to
 * special-case a kind here.
 */

// biome-ignore lint/suspicious/noExplicitAny: the registry is heterogeneous by design — each
// resolver has its own config and element types, and the store deliberately cannot see them.
export type ResolverRegistry = Readonly<Record<SpatialEntryKind, ResourceResolver<any, any>>>;

// biome-ignore lint/suspicious/noExplicitAny: see above.
export type AnyResolveContext = ResolveContext<any, any>;

export class SpatialEntryStore {
  private readonly resolvers: ResolverRegistry;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribes: Array<() => void> = [];
  /** One AbortController per in-flight task id. Superseding cancels the old one. */
  private readonly inFlight = new Map<string, AbortController>();
  private version = 0;

  constructor(resolvers: ResolverRegistry) {
    this.resolvers = resolvers;
    // The store's version is the sum of its parts: any resolver mutating is a
    // reason for React to re-read.
    for (const resolver of Object.values(resolvers)) {
      this.unsubscribes.push(resolver.subscribe(() => this.notify()));
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * PURE, SYNC. What work do these entries need? Starts nothing.
   *
   * Safe to call during render — which is the whole point of splitting it from
   * {@link reconcile}. Nothing here can begin a load even by accident.
   */
  plan(contexts: readonly AnyResolveContext[]): Array<[AnyResolveContext, ResolveTask]> {
    const tasks: Array<[AnyResolveContext, ResolveTask]> = [];
    for (const ctx of contexts) {
      const resolver = this.resolvers[ctx.kind];
      if (!resolver) continue;
      for (const task of resolver.plan(ctx)) {
        tasks.push([ctx, task]);
      }
    }
    return tasks;
  }

  /**
   * ASYNC. Plan, then load. Call from a commit-phase effect, never from render.
   *
   * Dedup and supersession are still each resolver's own business in Step 1 — they
   * keep today's in-flight-promise checks, byte for byte. The store only tracks an
   * `AbortController` per task id so a superseded request can be cancelled; the
   * `id` carries everything the request depends on, which is the seam Track A's
   * `RequestSlot` will take over.
   */
  async reconcile(contexts: readonly AnyResolveContext[]): Promise<void> {
    const tasks = this.plan(contexts);
    if (tasks.length === 0) {
      return;
    }

    await Promise.all(
      tasks.map(async ([ctx, task]) => {
        const resolver = this.resolvers[ctx.kind];
        if (!resolver) return;

        const previous = this.inFlight.get(task.id);
        if (previous) {
          // Same id ⇒ same request ⇒ the resolver will dedup. Don't abort it.
          return;
        }
        const controller = new AbortController();
        this.inFlight.set(task.id, controller);
        try {
          await resolver.load(task, ctx, controller.signal);
        } finally {
          // Only clear if still ours — a superseding request installs its own.
          if (this.inFlight.get(task.id) === controller) {
            this.inFlight.delete(task.id);
          }
        }
      })
    );
  }

  /** PURE, SYNC. The resolved state of one entry. Identity-stable between mutations. */
  snapshot(ctx: AnyResolveContext): EntryResources | undefined {
    return this.resolvers[ctx.kind]?.snapshot(ctx);
  }

  /** Is this entry still waiting on a resource it cannot first-paint without? */
  isBlocking(ctx: AnyResolveContext): boolean {
    const resolver = this.resolvers[ctx.kind];
    if (!resolver) return false;
    const snapshot = resolver.snapshot(ctx);
    return resolver.blockingResources.some((name) => {
      const resolution = snapshot.resources[name];
      if (!resolution) return false;
      // Loading with a retained `stale` still draws — that is what `stale` is FOR.
      // It blocks only when there is nothing to show at all.
      if (resolution.status === 'loading') return resolution.stale === undefined;
      return resolution.status === 'idle';
    });
  }

  evict(kind: SpatialEntryKind, elementKey: string): void {
    this.resolvers[kind]?.evict(elementKey);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    for (const resolver of Object.values(this.resolvers)) resolver.dispose();
    this.listeners.clear();
  }
}
