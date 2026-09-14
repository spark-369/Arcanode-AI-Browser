// Engine status indicator, progress bar, and toast notifications. Pure UI
// widgets driven by the AI client's progress/status events (wired in
// renderer.js); they know nothing about the rest of the app.

import { $ } from './dom.js';

const engineDot = $('#engine-dot');
const engineLabel = $('#engine-label');
const progressWrap = $('#progress-wrap');
const progressBar = $('#progress-bar');
const progressText = $('#progress-text');
const cancelBtn = $('#btn-cancel');

let activeRequestId = null;

export function setEngine(state, label) {
  engineDot.className = `dot ${state}`;
  engineLabel.textContent = label;
}

export function resetProgress() {
  progressWrap.hidden = true;
  progressWrap.classList.remove('indeterminate');
  progressBar.style.width = '0';
  progressText.textContent = '';
  cancelBtn.hidden = true;
}

export function setActiveRequestId(id) {
  activeRequestId = id;
  // Reveal the stop button as soon as a request starts. Relying on onProgress()
  // alone is unreliable: once a model is cached, transformers.js emits no
  // progress events during inference, so the button would never appear and the
  // user could not cancel. resetProgress() hides it again when the run settles.
  if (id) {
    progressWrap.hidden = false;
    cancelBtn.hidden = false;
  }
}

/** Reflects engine progress for the request the user is currently waiting on. */
export function onProgress(p) {
  // Only reflect progress for the request the user is currently waiting on.
  // Progress ids are namespaced as "<windowId>:<requestId>" by the engine, so
  // match by suffix against the bare request id we hold. When no request is
  // active (e.g. after a cancel), ignore all progress so a late event from the
  // aborted run cannot re-show the stop button.
  if (!activeRequestId) return;
  if (p.id && p.id !== activeRequestId && !p.id.endsWith(`:${activeRequestId}`)) return;

  if (p.phase === 'done') {
    resetProgress();
    return;
  }

  progressWrap.hidden = false;
  cancelBtn.hidden = false;

  if (p.phase === 'download' && typeof p.percent === 'number' && p.total) {
    progressWrap.classList.remove('indeterminate');
    progressBar.style.width = `${p.percent}%`;
    progressText.textContent = `${p.label} · ${p.percent}%`;
  } else {
    // Loading/working with no measurable total: indeterminate sweep.
    progressWrap.classList.add('indeterminate');
    progressText.textContent = p.label || 'Working…';
  }
}

export function onCancelClick(handler) {
  cancelBtn.addEventListener('click', () => {
    if (!activeRequestId) return;
    const id = activeRequestId;
    // Clear the active id first so any late progress from the aborted run is
    // filtered out and cannot re-show the stop button.
    activeRequestId = null;
    handler(id);
    // Hide the stop button + progress bar immediately for responsive feedback;
    // the cancelled request will settle shortly and reset state fully.
    resetProgress();
  });
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const toastsEl = $('#toasts');
export function toast(message, kind = '', ms = 2600) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  toastsEl.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, ms);
}
