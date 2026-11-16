import { describe, expect, it } from 'vitest';
import { readZarr } from '../src/store/index';

describe('readZarr on a store it cannot open', () => {
  it('rejects with the reader message once, without a stringified "Error:" prefix', async () => {
    const empty = { get: async () => undefined };
    const error = await readZarr(empty).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error && error.message).toMatch(/^Failed to open zarr store/);
  });
});
