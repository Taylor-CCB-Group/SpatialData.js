/**
 * Result type for explicit error handling without exceptions.
 * Inspired by Rust's Result<T, E>.
 * 
 * This type is useful for operations that can fail, especially in zarr operations
 * where errors should be handled explicitly rather than thrown as exceptions.
 * 
 * Note: This is a custom implementation for simplicity. We may review using
 * an existing Result library (such as neverthrow) in the future,
 * but for now this provides a lightweight, dependency-free solution.
 */

/**
 * A Result type for explicit error handling without exceptions.
 * Inspired by Rust's Result<T, E>.
 */
export type Result<T, E = Error> = 
  | { ok: true; value: T }
  | { ok: false; error: E };

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

