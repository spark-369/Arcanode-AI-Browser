// AI engine worker process. Runs in a SEPARATE process from the Electron main
// process so a crash, segfault, or OOM in the model runtime (native ONNX) can
// never take down the browser window — only this worker dies, and the host
// reports the failure gracefully. Communicates via process.send / on('message').

let engine;
let normalizeEngineError;
try {
  engine = require('./engine/index.js');
  normalizeEngineError = require('./engine/errors.js');
} catch (err) {
  if (process.send) {
    process.send({ type: 'error', error: err?.message || String(err) });
  }
  process.exit(1);
}

// Tracks runs that are currently in flight, keyed by namespaced request id,
// so a cancel can abort them instead of letting the worker hang.
const activeRuns = new Map(); // id -> { cancelled }

// Progress is forwarded to the host, tagged with the request id. Skip any
// malformed (empty/non-string) id so the host never receives an unusable tag.
engine.setProgressSink((id, data) => {
  const key = String(id == null ? '' : id).trim();
  if (!key || !key.includes(':')) return;
  if (process.send) process.send({ type: 'progress', id: key, data });
});

process.on('message', async (msg) => {
  if (!msg || !msg.type) return;

  try {
    if (msg.type === 'init') {
      engine.init(msg.cacheDir);
      // Emit readiness only after the worker has accepted initialization.
      if (process.send) process.send({ type: 'ready' });
      process.send({ type: 'result', id: msg.id, ok: true });
    } else if (msg.type === 'run') {
      const { task, inputs, options, model, requestId } = msg;
      const windowId = msg.windowId != null ? msg.windowId : 1;
      const id = `${windowId}:${requestId || 'req'}`;
      const run = { cancelled: false };
      activeRuns.set(id, run);
      try {
        const result = await engine.run(task, inputs, options, model, id);
        if (run.cancelled) {
          process.send({ type: 'result', id: msg.id, ok: false, error: 'Cancelled.' });
        } else {
          process.send({ type: 'result', id: msg.id, ok: true, result });
        }
      } finally {
        activeRuns.delete(id);
      }
    } else if (msg.type === 'cancel') {
      // Namespace the id the same way as `run` so it matches the active run.
      const id = `${msg.windowId}:${msg.requestId || msg.id}`;
      const run = activeRuns.get(id);
      if (run) run.cancelled = true;
      engine.cancel(id);
      process.send({ type: 'result', id: msg.id, ok: true });
    }
  } catch (err) {
    const raw = err?.message || String(err);
    const error = normalizeEngineError(raw);
    process.send({ type: 'result', id: msg.id, ok: false, error });
  }
});

// If the parent process goes away (or the IPC channel closes) while we're
// mid-send, `process.send` throws EPIPE. Swallow it so the worker exits quietly
// instead of crashing with an unhandled error.
process.on('disconnect', () => process.exit(0));
process.on('EPIPE', () => process.exit(0));
