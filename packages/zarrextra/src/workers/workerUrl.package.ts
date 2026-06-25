export function defaultWorkerUrl(): URL {
  const workerFile = './codec-worker.js';
  return new URL(workerFile, import.meta.url);
}
