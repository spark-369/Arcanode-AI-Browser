// Renderer-side client for the local AI engine, which runs in the main process
// (Node + native ONNX). Wraps the IPC calls in a promise API, multiplexes
// concurrent requests by id, forwards progress, and enforces a timeout so a
// wedged model can never leave the UI spinning.

import { api } from './api-bridge.js';

/** Hard ceiling for a single AI request. Model downloads are excluded: the
 *  timer resets whenever progress is reported. */
const IDLE_TIMEOUT_MS = 180_000;

let requestSeq = 0;
let initPromise = null;

const pending = new Map();
const progressListeners = new Set();
const statusListeners = new Set();

// --------------------------------------------------------------------------
// Status
// --------------------------------------------------------------------------

function emitStatus(state, detail) {
  statusListeners.forEach((cb) => {
    try {
      cb(state, detail);
    } catch (err) {
      console.error('status listener failed', err);
    }
  });
}

// --------------------------------------------------------------------------
// Progress from the main process
// --------------------------------------------------------------------------

if (api.onAiProgress) {
  api.onAiProgress((p) => {
    // Progress proves the engine is alive; extend the request's deadline.
    if (p.id) touch(p.id);
    progressListeners.forEach((cb) => cb(p));
  });
}

// --------------------------------------------------------------------------
// Request bookkeeping
// --------------------------------------------------------------------------

function touch(id) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    settle(id, { err: { message: 'The model stopped responding. Please try again.' } });
  }, IDLE_TIMEOUT_MS);
}

function settle(id, outcome) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  if (outcome.ok !== undefined) entry.resolve(outcome.ok);
  else entry.reject(new Error(outcome.err?.message || 'Unknown engine error.'));
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Boots the engine in the main process and waits for acknowledgement.
 * Memoized until a failure invalidates it.
 */
export function initEngine() {
  if (initPromise) return initPromise;

  initPromise = (api.aiInit ? api.aiInit() : Promise.resolve({ ok: true }))
    .then((data) => {
      // A structured `{ ok: false, error }` from the main process means the
      // worker failed to start; treat it like a rejection so the UI reports it.
      if (data && data.ok === false) {
        const err = new Error(data.error || 'The AI engine failed to start.');
        initPromise = null;
        emitStatus('error', err.message);
        throw err;
      }
      emitStatus('ready', 'Ready');
      return data;
    })
    .catch((err) => {
      initPromise = null;
      emitStatus('error', err.message);
      throw err;
    });

  return initPromise;
}

export function onProgress(cb) {
  progressListeners.add(cb);
  return () => progressListeners.delete(cb);
}

export function onStatus(cb) {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

/** Abandons a request. The main process is told to stop work for this id. */
export function cancel(id) {
  if (!id || !pending.has(id)) return;
  if (api.aiCancel) api.aiCancel(id);
  settle(id, { err: { message: 'Cancelled.' } });
}

function request(task, inputs, options = {}, model) {
  const id = `req-${++requestSeq}`;

  const promise = new Promise((resolve, reject) => {
    initEngine()
      .then(() => {
        if (!api.aiRun) {
          reject(new Error('The AI bridge is unavailable.'));
          return;
        }
        pending.set(id, { resolve, reject, timer: null });
        touch(id);
        api
          .aiRun({ task, inputs, options, model, requestId: id })
          .then((data) => {
            // The main process returns { error } on failure instead of
            // rejecting, so the IPC never logs an unhandled rejection.
            if (data && data.error) settle(id, { err: { message: data.error } });
            else settle(id, { ok: data });
          })
          .catch((err) => settle(id, { err: { message: err?.message || String(err) } }));
      })
      .catch(reject);
  });

  promise.requestId = id;
  return promise;
}

export const ai = {
  summarize: (text, options) => request('summarization', { text }, options),
  ask: (question, context, options) =>
    request('question-answering', { question, context }, options),
  embed: (text, options) => request('feature-extraction', { text }, options),
  search: (query, passages, options) =>
    request('search', { query, passages }, options),
  tone: (text, options) =>
    request('text-classification', { text }, options),
  // --- New on-device features ---
  ner: (text, options) => request('token-classification', { text }, options),
  zeroShot: (text, labels, multiLabel, options) =>
    request('zero-shot-classification', { text, labels, multiLabel }, options),
  sentiment: (text, options) => request('sentiment', { text }, options),
  toxicity: (text, options) => request('toxicity', { text }, options),
  readingTime: (text, options) => request('reading-time', { text }, options),
  keywords: (text, options) => request('keywords', { text }, options),
  cluster: (text, clusters, options) =>
    request('cluster', { text, clusters }, options),
  dedupe: (text, threshold, options) =>
    request('dedupe', { text, threshold }, options),
  related: (text, reference, options) =>
    request('related', { text, reference }, options),
  topic: (text, options) => request('topic', { text }, options),
  intent: (text, options) => request('intent', { text }, options),
  formality: (text, options) => request('formality', { text }, options),
  language: (text, options) => request('language', { text }, options),
  factuality: (text, options) => request('factuality', { text }, options),
  actionItems: (text, options) => request('action-items', { text }, options),
  questions: (text, options) => request('questions', { text }, options),
  glossary: (text, options) => request('glossary', { text }, options),
  outline: (text, options) => request('outline', { text }, options),
  contradiction: (text, claim, options) =>
    request('contradiction', { text, claim }, options),
  highlight: (text, options) => request('highlight', { text }, options),
  // --- Batch 2 ---
  bias: (text, options) => request('bias', { text }, options),
  emotion: (text, options) => request('emotion', { text }, options),
  sarcasm: (text, options) => request('sarcasm', { text }, options),
  urgency: (text, options) => request('urgency', { text }, options),
  politics: (text, options) => request('politics', { text }, options),
  age: (text, options) => request('age', { text }, options),
  genre: (text, options) => request('genre', { text }, options),
  coherence: (text, options) => request('coherence', { text }, options),
  simplicity: (text, options) => request('simplicity', { text }, options),
  duplicates: (text, options) => request('duplicates', { text }, options),
  keyphrases: (text, options) => request('keyphrases', { text }, options),
  faq: (text, options) => request('faq', { text }, options),
  claims: (text, options) => request('claims', { text }, options),
  quotes: (text, options) => request('quotes', { text }, options),
  acronyms: (text, options) => request('acronyms', { text }, options),
  numbers: (text, options) => request('numbers', { text }, options),
  dates: (text, options) => request('dates', { text }, options),
  persons: (text, options) => request('persons', { text }, options),
  places: (text, options) => request('places', { text }, options),
  orgs: (text, options) => request('orgs', { text }, options),
};

/** Frees nothing on the renderer side; the engine lives in the main process. */
export function shutdown() {
  for (const id of [...pending.keys()]) settle(id, { err: { message: 'Engine shut down.' } });
}
