// Registers our codecs; must run before any message is handled.
import './codec-worker-init';
import {
  type CodecWorkerMessage,
  handleCodecMessage,
} from '@fideus-labs/fizarrita/internals/codec-worker-core';

// The listener is installed here rather than by a bare import of
// '@fideus-labs/fizarrita/codec-worker': fizarrita declares `sideEffects: false`, so
// an app's production build of this file drops that import and the worker never answers.
interface CodecWorkerScope {
  addEventListener(type: 'message', listener: (event: { data: CodecWorkerMessage }) => void): void;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
}
declare const self: CodecWorkerScope;

self.addEventListener('message', async (event) => {
  const reply = await handleCodecMessage(event.data);
  if (!reply) return;
  try {
    self.postMessage(reply.response, reply.transfer);
  } catch (error) {
    // Unclonable or detached payload: answer without it so the caller's request settles.
    self.postMessage({
      type: reply.response.type,
      id: reply.response.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
