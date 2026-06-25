import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutputChunk, RollupOutput } from 'rollup';
import { build } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChunkDecodeBackend } from '../src/chunkDecode';
import { disableWorkerChunkDecode, enableWorkerChunkDecode } from '../src/workers/index';
import {
  disableWorkerChunkDecode as disablePackageWorkerChunkDecode,
  enableWorkerChunkDecode as enablePackageWorkerChunkDecode,
} from '../src/workers/index.package';

vi.mock('@fideus-labs/worker-pool', () => {
  class MockWorkerPool {
    terminateWorkers = vi.fn();
  }
  return { WorkerPool: MockWorkerPool };
});

function rollupOutputs(output: RollupOutput | RollupOutput[]): RollupOutput[] {
  return Array.isArray(output) ? output : [output];
}

function isChunk(item: RollupOutput['output'][number]): item is OutputChunk {
  return item.type === 'chunk';
}

describe('worker chunk decode setup', () => {
  afterEach(() => {
    disableWorkerChunkDecode();
    disablePackageWorkerChunkDecode();
  });

  it('enables the fizarrita chunk decode backend', () => {
    enableWorkerChunkDecode({ workers: 2 });
    const backend = getChunkDecodeBackend();
    expect(getChunkDecodeBackend()).toMatchObject({
      kind: 'fizarrita',
    });
    expect(backend.kind === 'fizarrita' && backend.options?.workerUrl).toBeTruthy();
  });

  it('resets to main-thread decode on disable', () => {
    const pool = enableWorkerChunkDecode({ workers: 2 });
    disableWorkerChunkDecode();
    expect(getChunkDecodeBackend()).toEqual({ kind: 'main' });
    expect(pool.terminateWorkers).toHaveBeenCalledOnce();
  });

  it('uses the packaged worker asset from the package entry', () => {
    enablePackageWorkerChunkDecode({ workers: 2 });
    const backend = getChunkDecodeBackend();
    expect(backend.kind).toBe('fizarrita');

    if (backend.kind !== 'fizarrita') {
      throw new Error(`Expected fizarrita backend, got ${backend.kind}`);
    }

    const workerUrl = String(backend.options?.workerUrl);
    expect(workerUrl).toContain('codec-worker.js');
    expect(workerUrl).not.toContain('codec-worker.ts');
  });

  it('bundles the fizarrita codec-worker message handler', async () => {
    const bundle = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        sourcemap: false,
        target: 'es2022',
        lib: {
          entry: resolve(
            fileURLToPath(new URL('.', import.meta.url)),
            '../src/workers/codec-worker.ts'
          ),
          formats: ['es'],
          fileName: () => 'codec-worker.js',
        },
        rollupOptions: {
          external: () => false,
          treeshake: false,
          output: {
            codeSplitting: false,
          },
        },
      },
    });

    const code = rollupOutputs(bundle)
      .flatMap((output) => output.output.filter(isChunk))
      .map((chunk) => chunk.code)
      .join('\n');

    expect(code).toContain('init_ok');
    expect(code).toContain('No pipeline for metaId');
  });
});
