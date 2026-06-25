/// <reference types="vite/client" />

import codecWorkerUrl from './codec-worker?worker&url';

export function defaultWorkerUrl(): string {
  return codecWorkerUrl;
}
