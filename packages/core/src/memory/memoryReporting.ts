/**
 * Memory accounting — the scalar, and nothing else.
 *
 * See [ADR 0005](../../../../docs/adr/0005-memory-accounting-before-management.md).
 * Deliberately one number: no tiers, no policy, no eviction, no ceiling. Those
 * are later rungs, and the ADR gates every one of them on this existing first.
 */

/**
 * Anything holding resident host memory can report it in bytes.
 *
 * The name is the design. `byteLength` is what `TypedArray`, `ArrayBuffer` and
 * `DataView` already call this, so all of them satisfy this interface
 * structurally — for free, with no wrapper and no import:
 *
 * ```ts
 * const resident: MemoryReporting = new Uint8Array(1024); // 1024
 * ```
 *
 * That is what makes it cheap enough to put on every cache: the payloads we
 * actually hold are mostly typed arrays already, and the containers around them
 * only have to keep a running total.
 *
 * ### The obligation this creates
 *
 * Keep it cheap. A cache implementing this must maintain a running total across
 * insert and evict rather than scanning its residents on every read — callers
 * are expected to be free to poll it (a HUD, a test assertion, a decision about
 * what to drop next) without that being a performance question.
 *
 * ### What it deliberately cannot express
 *
 * A scalar cannot distinguish an encoded tier from a decoded one, and it cannot
 * see a worker heap that a synchronous getter has no access to. Both are real
 * for SpatialData.ts, and both are deferred: the tiered `ResidencyReport` is
 * ADR 0005 rung 5, and the ADR's position is that it should not be built until
 * something needs to *act* on the difference between tiers.
 */
export interface MemoryReporting {
  /** Resident bytes held by this object, right now. */
  readonly byteLength: number;
}
