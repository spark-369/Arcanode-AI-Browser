// Node-side AI engine core. Runs Transformers.js using the native
// `onnxruntime-node` backend (the package's `main` entry) rather than the
// browser bundle in a Web Worker: faster (no WASM threading), more reliable (no
// file:// / asar quirks), and keeps all model code out of the renderer. Pipelines
// are cached per task; progress is forwarded through a callback the main process
// wires to IPC. Task logic lives in ./handlers.js; config in ./config.js.

// Force IPv4 for model downloads (see module for why).
require('../net-ipv4.js');

const { pipeline, env } = require('@xenova/transformers');
const { MODELS, PIPELINE_TASK, LABELS } = require('./config.js');
const { HANDLERS } = require('./handlers.js');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function configure(cacheDir) {
  if (cacheDir) {
    env.cacheDir = cacheDir;
    env.localModelPath = cacheDir;
  }
  env.allowLocalModels = true;
  env.allowRemoteModels = true;
  // Native backend; no WASM path needed.
  env.backends.onnx.wasm = env.backends.onnx.wasm || {};
  // Silence ONNX Runtime's verbose graph-optimization warnings on load.
  if (env.backends.onnx) env.backends.onnx.loggingLevel = 'error';
}

// ---------------------------------------------------------------------------
// Progress plumbing
// ---------------------------------------------------------------------------

const pipelineCache = new Map();
const loadingPipelines = new Map();
// Active runs keyed by namespaced request id ("<windowId>:<requestId>") so
// cancel() can drop an in-flight model load for that specific request.
const activeRuns = new Map();

let cacheDir = null;
let progressSink = null; // (id, data) => void

function setProgressSink(fn) {
  progressSink = typeof fn === 'function' ? fn : null;
}

function emitProgress(id, data) {
  if (progressSink) {
    try {
      progressSink(id, data);
    } catch {
      /* ignore */
    }
  }
}

function makeProgressCallback(id, label) {
  return (p) => {
    if (p.status === 'progress' && typeof p.loaded === 'number' && p.total) {
      emitProgress(id, {
        phase: 'download',
        label: `Downloading ${label}`,
        file: p.file || '',
        loaded: p.loaded,
        total: p.total,
        percent: Math.min(100, Math.round((p.loaded / p.total) * 100)),
      });
    } else if (p.status === 'initiate') {
      emitProgress(id, { phase: 'download', label: `Fetching ${p.file || label}`, percent: 0 });
    } else if (p.status === 'done') {
      emitProgress(id, { phase: 'download', label: `Loaded ${p.file || label}`, percent: 100 });
    } else if (p.status === 'ready') {
      emitProgress(id, { phase: 'ready', label: `${label} ready`, percent: 100 });
    }
  };
}

// ---------------------------------------------------------------------------
// Pipeline loading
// ---------------------------------------------------------------------------

async function getPipeline(task, modelName, id, label) {
  const key = `${task}:${modelName}`;
  const ready = pipelineCache.get(key);
  if (ready) return ready;

  const inFlight = loadingPipelines.get(key);
  if (inFlight) return inFlight;

  const load = pipeline(PIPELINE_TASK[task] || task, modelName, {
    progress_callback: makeProgressCallback(id, label),
    quantized: true,
  })
    .then((pipe) => {
      pipelineCache.set(key, pipe);
      loadingPipelines.delete(key);
      return pipe;
    })
    .catch((err) => {
      loadingPipelines.delete(key);
      throw err;
    });

  loadingPipelines.set(key, load);
  return load;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function init(dir) {
  cacheDir = dir || cacheDir;
  configure(cacheDir);
  return { ok: true, cacheDir };
}

async function run(task, inputs = {}, options = {}, model, id = 'req') {
  const handler = HANDLERS[task];
  if (!handler) throw new Error(`Unsupported task "${task}".`);

  const modelName = model || MODELS[task];
  if (!modelName) throw new Error(`No model configured for "${task}".`);

  const label = LABELS[task] || task;

  activeRuns.set(id, { cancelled: false });
  try {
    emitProgress(id, { phase: 'load', label: `Preparing ${label}`, percent: 0 });
    const pipe = await getPipeline(task, modelName, id, label);

    if (activeRuns.get(id)?.cancelled) throw new Error('Cancelled.');

    emitProgress(id, { phase: 'work', label: 'Running locally', percent: 0 });
    const data = await handler(pipe, inputs, options, id, emitProgress);

    emitProgress(id, { phase: 'done', label: '', percent: 100 });
    return data;
  } finally {
    activeRuns.delete(id);
  }
}

// Best-effort cancellation. A running ONNX graph cannot be interrupted, so we
// flag the run so it aborts at the next await, and drop any in-flight pipeline
// load so a queued request does not start.
function cancel(id) {
  const run = activeRuns.get(id);
  if (run) run.cancelled = true;
  for (const [key, load] of loadingPipelines) {
    if (key.endsWith(id) || id.endsWith(key)) {
      loadingPipelines.delete(key);
      load.catch(() => {});
    }
  }
}

module.exports = { init, run, cancel, setProgressSink, MODELS };
