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

// biome-ignore lint/suspicious/noExplicitAny: the registry is heterogeneous by design — each resolver has its own config and element types, and the store deliberately cannot see them.
export type ResolverRegistry = Readonly<Record<SpatialEntryKind, ResourceResolver<any, any>>>;

// biome-ignore lint/suspicious/noExplicitAny: see above.
export type AnyResolveContext = ResolveContext<any, any>;

export class SpatialEntryStore {
  private readonly resolvers: ResolverRegistry;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribes: Array<() => void> = [];
  /** One AbortController per in-flight task id. Superseding cancels the old one. */
  private readonly inFlight = new Map<string, AbortController>();

  constructor(resolvers: ResolverRegistry) {
    this.resolvers = resolvers;
  }

  /**
   * The store's version is the sum of its parts: any resolver mutating is a reason
   * for React to re-read. The bridge that carries that is tied to HAVING LISTENERS,
   * not to construction — because the store outlives the effect that consumes it.
   *
   * Subscribing in the constructor and tearing down in `dispose` looks equivalent
   * and is not. `dispose()` runs from a React effect cleanup, and an effect cleanup
   * is not "the end": StrictMode's dev double-mount runs cleanup and then re-runs
   * the effect against the SAME memoised store. A constructor-time bridge cannot be
   * rebuilt, so from that moment the store was permanently deaf to its own resolvers
   * — every async settle after mount was dropped, and a fill-colour column whose
   * rows landed after the switch never repainted until an unrelated re-render (a
   * pan) happened to come along. Attaching on the first listener and detaching on
   * the last makes the bridge exactly as long-lived as someone caring about it, and
   * survives any number of remounts.
   */
  private attachResolvers(): void {
    if (this.unsubscribes.length > 0) return;
    for (const resolver of Object.values(this.resolvers)) {
      this.unsubscribes.push(resolver.subscribe(() => this.notify()));
    }
  }

  private detachResolvers(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.attachResolvers();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.detachResolvers();
    };
  };

  /**
   * The sum of its parts, DERIVED rather than counted.
   *
   * A counter incremented from the notification bridge would only be correct while
   * something was subscribed — and the bridge is now listener-driven, so that is not
   * always. Summing the resolvers' own versions makes this a pure read of the state
   * it describes: true with a listener, without one, and across a dispose.
   */
  getVersion = (): number => {
    let version = 0;
    for (const resolver of Object.values(this.resolvers)) version += resolver.getVersion();
    return version;
  };

  private notify(): void {
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

  /**
   * Release everything this store owns. Not a one-way door: a later `subscribe`
   * re-attaches the resolver bridge, which is what lets a StrictMode remount (or any
   * effect that re-runs against the same store) recover instead of going silent.
   */
  dispose(): void {
    this.detachResolvers();
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    for (const resolver of Object.values(this.resolvers)) resolver.dispose();
    this.listeners.clear();
  }
}
