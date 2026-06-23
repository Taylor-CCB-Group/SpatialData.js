/**
 * Minimal Result type for explicit error handling without exceptions.
 * Inspired by Rust's Result<T, E>.
 *
 * Adoption in this monorepo is intentionally narrow. If we expand Result use,
 * we would likely adopt an established library (e.g. neverthrow) rather than
 * grow this in-house API — treat these helpers as provisional.
 */

/**
 * A Result type for explicit error handling without exceptions.
 * Inspired by Rust's Result<T, E>.
 */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/** Create a successful Result */
export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** Create a failed Result */
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Type guard for Ok results */
export const isOk = <T, E>(result: Result<T, E>): result is { ok: true; value: T } => result.ok;

/** Type guard for Err results */
export const isErr = <T, E>(result: Result<T, E>): result is { ok: false; error: E } => !result.ok;

/**
 * Unwrap a Result, throwing if it's an error.
 * Use when you want to convert back to exception-based error handling.
 */
export const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.ok) return result.value;
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
};

/**
 * Unwrap a Result with a default value for errors.
 */
export const unwrapOr = <T, E>(result: Result<T, E>, defaultValue: T): T => {
  return result.ok ? result.value : defaultValue;
};
