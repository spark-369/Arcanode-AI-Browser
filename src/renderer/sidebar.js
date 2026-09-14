// Sidebar: resize handle, show/hide toggle, the feature launcher grid, and the
// modal host that shows one feature panel at a time.

import { $, $$ } from './dom.js';
import { persistSettings } from './settings.js';
import { refreshHistory } from './features.js';

const appEl = $('#app');
const aiPane = $('#ai-pane');
const resizer = $('#resizer');

const launcher = $('#ai-launcher');
const modal = $('#ai-modal');
const modalTitle = $('#ai-modal-title');
const modalIc = $('#ai-modal-ic');

const toggleBtn = $('#btn-toggle-sidebar');

let tabsRef = null;

export function initResizer(tabs) {
  tabsRef = tabs;
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const width = Math.min(Math.max(window.innerWidth - e.clientX, 300), 620);
    aiPane.style.width = `${width}px`;
    tabs.syncBounds();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    persistSettings();
  });
}

export function toggleSidebar(force) {
  const hidden = force ?? !appEl.classList.contains('sidebar-hidden');
  appEl.classList.toggle('sidebar-hidden', hidden);
  toggleBtn.classList.toggle('on', !hidden);
  // The browser pane grows/shrinks when the sidebar toggles; push the new
  // rectangle to the native page view so it resizes with the pane.
  if (tabsRef) tabsRef.syncBounds();
  persistSettings();
  return hidden;
}

export function isSidebarHidden() {
  return appEl.classList.contains('sidebar-hidden');
}

export function openFeature(name, iconHref) {
  if (!FEATURE_TITLES[name]) return;
  if (isSidebarHidden()) toggleSidebar(false);
  launcher.hidden = true;
  modal.hidden = false;
  modalTitle.textContent = FEATURE_TITLES[name];
  if (iconHref) modalIc.querySelector('use').setAttribute('href', iconHref);
  $$('.feature-panel').forEach((p) =>
    p.classList.toggle('active', p.dataset.panel === name)
  );
  // History is a live view — refresh it whenever its panel is opened.
  if (name === 'history') refreshHistory();
}

export function closeFeature() {
  modal.hidden = true;
  launcher.hidden = false;
}

export function initLauncher() {
  $('#btn-modal-back').addEventListener('click', closeFeature);
}

export function getAiPane() {
  return aiPane;
}

// Feature display titles, keyed by feature name.
export const FEATURE_TITLES = {
  history: 'History',
  summarize: 'Summarize',
  ask: 'Ask',
  search: 'Search',
  tone: 'Tone',
  reading: 'Reading time',
  keywords: 'Keywords',
  sentiment: 'Sentiment',
  topic: 'Topic',
  language: 'Language',
  formality: 'Formality',
  factuality: 'Factuality',
  toxicity: 'Toxicity',
  intent: 'Intent',
  ner: 'Entities',
  outline: 'Outline',
  highlight: 'Highlights',
  cluster: 'Cluster',
  dedupe: 'Dedupe',
  action: 'Action items',
  questions: 'Questions',
  glossary: 'Glossary',
  related: 'Related',
  zshot: 'Custom labels',
  contradiction: 'Check claim',
  // --- Batch 2 ---
  bias: 'Bias',
  emotion: 'Emotion',
  sarcasm: 'Sarcasm',
  urgency: 'Urgency',
  politics: 'Political lean',
  age: 'Audience age',
  genre: 'Genre',
  coherence: 'Coherence',
  simplicity: 'Simplicity',
  duplicates: 'Duplicates',
  keyphrases: 'Keyphrases',
  faq: 'FAQ finder',
  claims: 'Claims',
  quotes: 'Quotes',
  acronyms: 'Acronyms',
  numbers: 'Numbers',
  dates: 'Dates',
  persons: 'People',
  places: 'Places',
  orgs: 'Organizations',
};
