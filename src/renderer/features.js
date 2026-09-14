// AI feature wiring: one central dispatcher, one declarative registry.
//
// Every on-device feature is described once in the FEATURES registry and
// executed by a single runFeature(). Each entry declares: `tab` (ai.* method),
// `kind` (how to render), `args` ((text, input) => [...]), `input` (optional
// text field), and `render` (paints the result). Adding or fixing a tool is a
// one-line, data-only change.

import { $, $$ } from './dom.js';
import { ai, initEngine } from '../ai/client.js';
import { toast, setActiveRequestId, setEngine, resetProgress } from './engine-ui.js';
import { openFeature, FEATURE_TITLES } from './sidebar.js';
import {
  getHistory,
  deleteHistory,
  clearHistory,
} from './history.js';

// ---------------------------------------------------------------------------
// Shared state + helpers
// ---------------------------------------------------------------------------

let engineReady = false;
export function setEngineReady(v) { engineReady = v; }

let tabsRef = null;
export function bindTabs(tabs) { tabsRef = tabs; }

const INPUT_LIMIT = {
  summarization: 3500,
  'question-answering': 6000,
  'feature-extraction': 2000,
  search: 2000,
  'text-classification': 512,
  'token-classification': 1500,
  'zero-shot-classification': 1500,
  'reading-time': 4000,
  keywords: 3000,
  cluster: 4000,
  dedupe: 4000,
  related: 4000,
  'action-items': 4000,
  questions: 6000,
  glossary: 4000,
  outline: 4000,
  contradiction: 1500,
  intent: 512,
  formality: 512,
  language: 512,
  highlight: 4000,
  coherence: 4000,
  simplicity: 4000,
  duplicates: 4000,
  keyphrases: 3000,
  faq: 4000,
  claims: 4000,
  quotes: 4000,
  acronyms: 1500,
  numbers: 4000,
  dates: 4000,
  persons: 1500,
  places: 1500,
  orgs: 1500,
};

function setBusy(busy, label) {
  setEngine(busy ? 'busy' : engineReady ? 'ready' : 'error', label || (busy ? 'Working…' : engineReady ? 'Ready' : 'Error'));
  $$('.btn.primary').forEach((b) => (b.disabled = busy));
}

function getSelection() {
  return tabsRef ? tabsRef.getSelection() : Promise.resolve('');
}
function getText() {
  return tabsRef ? tabsRef.getText() : Promise.resolve('');
}

// Text a feature analyzes: the user's current selection when present, otherwise
// the readable text of the whole page (so a manual selection is optional).
async function getAnalysisText() {
  const selection = (await getSelection())?.trim();
  if (selection) return selection;
  return (await getText())?.trim() || '';
}

// "No text to analyze" notice shown in an output area.
function showNoText(out) {
  const text = 'This page has no readable text to analyze yet. Navigate to a page, then try again.';
  if (!out) return;
  out.className = 'output info';
  out.replaceChildren();
  const box = document.createElement('div');
  box.className = 'info-box';
  const ic = document.createElement('span');
  ic.className = 'info-ic';
  ic.innerHTML = '<svg class="ic"><use href="#i-info" /></svg>';
  const msg = document.createElement('span');
  msg.className = 'info-msg';
  msg.textContent = text;
  box.append(ic, msg);
  out.appendChild(box);
}

// Warning shown when the selected/page text exceeds the model's input limit.
function showContextWarning(out, textLen, limit) {
  if (!out) return;
  out.className = 'output warn';
  out.replaceChildren();
  const box = document.createElement('div');
  box.className = 'info-box';
  const ic = document.createElement('span');
  ic.className = 'info-ic';
  ic.innerHTML = '<svg class="ic"><use href="#i-warn" /></svg>';
  const msg = document.createElement('span');
  msg.className = 'info-msg';
  msg.textContent = `The page text (${textLen.toLocaleString()} chars) exceeds this model's input limit (${limit.toLocaleString()} chars). Select a smaller portion of the page and try again.`;
  box.append(ic, msg);
  out.appendChild(box);
}

// Centered info notice for empty-result messages (e.g. "No FAQ-like passages detected.").
function showEmptyMessage(out, message) {
  if (!out) return;
  out.className = 'output info';
  out.replaceChildren();
  const box = document.createElement('div');
  box.className = 'info-box';
  const ic = document.createElement('span');
  ic.className = 'info-ic';
  ic.innerHTML = '<svg class="ic"><use href="#i-info" /></svg>';
  const msg = document.createElement('span');
  msg.className = 'info-msg';
  msg.textContent = message;
  box.append(ic, msg);
  out.appendChild(box);
}

// Split text into sentence-ish passages for semantic search.
function toPassages(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  const parts = clean.match(/[^.!?]+[.!?]+|\S+$/g) || [];
  return parts.map((p) => p.trim()).filter((p) => p.length > 3);
}

// ---------------------------------------------------------------------------
// Result renderers
// ---------------------------------------------------------------------------

function renderText(out, text) {
  out.className = 'output';
  out.textContent = text;
}

// Render a list of {text, score?} items as search-result cards. Shared by the
// `list` and `search` kinds (the latter passes pre-ranked results).
function renderList(out, items) {
  if (!items || !items.length) {
    out.className = 'output';
    out.textContent = 'No results.';
    return;
  }
  out.className = 'output';
  out.replaceChildren();
  for (const it of items) {
    const p = document.createElement('div');
    p.className = 'search-item';
    const text = document.createElement('p');
    text.className = 'search-text';
    text.textContent = it.text;
    p.appendChild(text);
    if (typeof it.score === 'number') {
      const pct = Math.round(it.score * 100);
      const meter = document.createElement('div');
      meter.className = 'search-meter';
      const track = document.createElement('div');
      track.className = 'search-meter-track';
      const fill = document.createElement('div');
      fill.className = 'search-meter-fill';
      fill.style.width = `${Math.min(100, pct)}%`;
      track.appendChild(fill);
      const val = document.createElement('span');
      val.className = 'search-meter-val';
      val.textContent = `${pct}%`;
      meter.append(track, val);
      p.appendChild(meter);
    }
    out.appendChild(p);
  }
}

// Render ranked [{label, score}] as Tone-style bars. `max`/`min` tune how many
// and how faint a label may be to still be shown.
function renderToneBars(results, labels, { max = 8, min = 0.005 } = {}) {
  results.replaceChildren();
  const shown = labels
    .filter((r, i) => r.score >= min || i === 0)
    .slice(0, max);
  if (!shown.length) {
    const p = document.createElement('p');
    p.className = 'tone-empty';
    p.textContent = 'No clear result detected.';
    results.appendChild(p);
    return;
  }
  for (const r of shown) {
    const pct = Math.round(r.score * 100);
    const item = document.createElement('div');
    item.className = 'tone-item';

    const head = document.createElement('div');
    head.className = 'tone-head';
    const name = document.createElement('span');
    name.className = 'tone-label';
    name.textContent = r.label;
    const val = document.createElement('span');
    val.className = 'tone-val';
    val.textContent = `${pct}%`;
    head.append(name, val);

    const track = document.createElement('div');
    track.className = 'tone-track';
    const fill = document.createElement('div');
    fill.className = 'tone-fill';
    fill.style.width = `${Math.min(100, pct)}%`;
    track.appendChild(fill);

    item.append(head, track);
    results.appendChild(item);
  }
}

function renderActionList(results, result) {
  results.replaceChildren();
  const items = (result && result.results) || [];
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'tone-empty';
    p.textContent = 'No clear action items detected.';
    results.appendChild(p);
    return;
  }
  for (const it of items.slice(0, 10)) {
    const p = document.createElement('p');
    p.className = 'search-text';
    p.textContent = `• ${it.text}`;
    results.appendChild(p);
  }
}

function renderSearchResults(container, results) {
  renderList(container, results);
}

// Extract a ranked [{label, score}] list from any plausible engine result
// shape (parallel arrays, array of objects, or nested wrapper).
function extractRanked(result) {
  if (!result || typeof result !== 'object') return [];
  const src = result.result && typeof result.result === 'object' ? result.result : result;
  let pairs = [];
  if (Array.isArray(src.labels) && Array.isArray(src.scores)) {
    pairs = src.labels.map((label, i) => ({ label, score: src.scores[i] }));
  } else if (
    Array.isArray(src.labels) &&
    src.labels.length &&
    typeof src.labels[0] === 'object' &&
    'score' in src.labels[0]
  ) {
    pairs = src.labels.map((r) => ({ label: r.label, score: r.score }));
  } else if (Array.isArray(src)) {
    pairs = src.map((r) => ({ label: r?.label, score: r?.score }));
  }
  return pairs
    .filter((r) => r && (typeof r.label === 'string' || typeof r.label === 'number'))
    .map((r) => ({ label: String(r.label), score: typeof r.score === 'number' ? r.score : 0 }))
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Feature registry — the single source of truth for every tool.
// ---------------------------------------------------------------------------

// Each feature declares a `hint` (shown in its panel) plus the fields already
// used by the dispatcher. Panels are generated from this registry at runtime
// (see buildPanels), so index.html stays free of ~40 near-identical sections.
const FEATURES = {
  // --- Local, non-AI tools (rendered like a feature, but no model call) ---
  history: {
    custom: 'history',
    hint: 'Pages you have visited, stored on-device in IndexedDB. Click to reopen, or delete individual entries.',
  },

  // --- Headline features (now driven by the same central dispatcher) ---
  summarize: {
    tab: 'summarize', kind: 'text', out: 'out-summarize',
    hint: 'Condense the page you are viewing into a short summary.',
    args: (text) => [text],
    render: (out, r) => renderText(out, r.summary || 'No summary returned.'),
  },
  ask: {
    tab: 'ask', kind: 'qa', out: 'out-ask',
    input: { id: 'ask-input', msg: 'Type a question first.', required: true },
    hint: 'Ask a question and get an answer extracted from the page.',
    args: (text, question) => [question, text],
    render: (out, r, ctx) => {
      out.className = 'output';
      out.replaceChildren();
      const q = document.createElement('span');
      q.className = 'qa-q';
      q.textContent = ctx.question;
      const a = document.createElement('span');
      a.textContent = r.answer || 'No answer found.';
      out.append(q, a);
      if (typeof r.score === 'number') {
        const s = document.createElement('span');
        s.className = 'qa-score';
        s.textContent = `Confidence: ${(r.score * 100).toFixed(0)}%`;
        out.append(s);
      }
    },
  },
  search: {
    tab: 'search', kind: 'search', out: 'search-results',
    input: { id: 'search-input', msg: 'Type something to search for.', required: true },
    hint: 'Semantic search across the selected text (or the whole page) using the on-device embedding model.',
    args: (text, query) => [query, toPassages(text)],
    render: (out, r) => renderSearchResults(out, r.results || []),
  },
  tone: {
    tab: 'tone', kind: 'ranked', results: 'tone-results',
    hint: 'Detect the emotions in the selected text with an on-device go_emotions classifier.',
    analyzing: 'Reading the tone of your text…', max: 6, min: 0.04,
  },

  // --- Text-output features ---
  reading: {
    tab: 'readingTime', kind: 'text', out: 'out-reading',
    hint: 'Estimate reading time and lexical density for the page.',
    args: (text) => [text],
    render: (out, r) =>
      renderText(out, `≈ ${r.minutes} min read · ${r.words} words @ ${r.wpm} wpm\nLexical density: ${r.density}`),
  },
  keywords: {
    tab: 'keywords', kind: 'text', out: 'out-keywords',
    hint: 'Extract the most representative keywords from the page.',
    args: (text) => [text],
    render: (out, r) => renderText(out, (r.keywords || []).join(', ') || 'No keywords found.'),
  },
  ner: {
    tab: 'ner', kind: 'text', out: 'out-ner',
    hint: 'Extract named entities (people, organizations, places).',
    args: (text) => [text],
    render: (out, r) => {
      const byType = {};
      for (const e of r.entities || []) (byType[e.entity] ||= []).push(e.word);
      const lines = Object.entries(byType).map(([k, v]) => `${k}: ${[...new Set(v)].join(', ')}`);
      renderText(out, lines.join('\n') || 'No entities found.');
    },
  },
  outline: {
    tab: 'outline', kind: 'text', out: 'out-outline',
    hint: 'Build a section outline from the page text.',
    args: (text) => [text],
    render: (out, r) => {
      out.className = 'output';
      out.replaceChildren();
      for (const s of r.sections || []) {
        const h = document.createElement('p');
        h.className = 'search-text';
        h.style.color = 'var(--accent-hi)';
        h.textContent = `▸ ${s.title}`;
        out.appendChild(h);
        for (const p of s.points) {
          const t = document.createElement('p');
          t.className = 'search-text';
          t.style.paddingLeft = '14px';
          t.textContent = `• ${p}`;
          out.appendChild(t);
        }
      }
    },
  },
  highlight: {
    tab: 'highlight', kind: 'list', out: 'out-highlight',
    hint: 'Surface the most important sentences on the page.',
    args: (text) => [text],
    render: (out, r) => renderList(out, r.results),
  },
  cluster: {
    tab: 'cluster', kind: 'text', out: 'out-cluster',
    hint: 'Group the page’s sentences into semantic clusters.',
    args: (text) => [text],
    render: (out, r) => {
      out.className = 'output';
      out.replaceChildren();
      (r.clusters || []).forEach((c) => {
        const h = document.createElement('p');
        h.className = 'search-text';
        h.style.color = 'var(--accent-hi)';
        h.textContent = `Cluster ${c.id + 1} (${c.size})`;
        out.appendChild(h);
        for (const it of c.items.slice(0, 3)) {
          const t = document.createElement('p');
          t.className = 'search-text';
          t.style.paddingLeft = '14px';
          t.textContent = `• ${it}`;
          out.appendChild(t);
        }
      });
    },
  },
  dedupe: {
    tab: 'dedupe', kind: 'text', out: 'out-dedupe',
    hint: 'Remove near-duplicate passages from the page.',
    args: (text) => [text],
    render: (out, r) =>
      renderText(out, `Removed ${r.removed} of ${r.total} near-duplicate passages.\n\n${(r.kept || []).join('\n\n')}`),
  },
  questions: {
    tab: 'questions', kind: 'text', out: 'out-questions',
    hint: 'Generate study questions from the page.',
    args: (text) => [text],
    render: (out, r) => {
      out.className = 'output';
      out.replaceChildren();
      for (const q of r.results || []) {
        const p = document.createElement('p');
        p.className = 'search-text';
        const c = document.createElement('span');
        c.style.color = 'var(--fg-dim)';
        c.textContent = `${q.question}\n`;
        const s = document.createElement('span');
        s.textContent = q.context;
        p.append(c, s);
        out.appendChild(p);
      }
    },
  },
  glossary: {
    tab: 'glossary', kind: 'text', out: 'out-glossary',
    hint: 'Extract defined terms and their meanings.',
    args: (text) => [text],
    render: (out, r) => {
      out.className = 'output';
      out.replaceChildren();
      for (const t of r.terms || []) {
        const p = document.createElement('p');
        p.className = 'search-text';
        const term = document.createElement('span');
        term.style.color = 'var(--accent-hi)';
        term.style.fontWeight = '600';
        term.textContent = `${t.term}: `;
        const def = document.createElement('span');
        def.textContent = t.definition;
        p.append(term, def);
        out.appendChild(p);
      }
    },
  },
  related: {
    tab: 'related', kind: 'list', out: 'out-related',
    input: { id: 'related-input', msg: 'Type a reference snippet first.', required: true },
    hint: 'Find passages most related to a reference snippet.',
    args: (text, ref) => [text, ref],
    render: (out, r) => renderList(out, r.results),
  },

  // --- Ranked (classification) features ---
  sentiment: {
    tab: 'sentiment', kind: 'ranked', results: 'sentiment-results',
    hint: 'Classify the page’s sentiment as positive or negative.',
    analyzing: 'Reading the sentiment of your text…',
  },
  topic: {
    tab: 'topic', kind: 'ranked', results: 'topic-results',
    hint: 'Detect the main topic of the page.',
    analyzing: 'Detecting the topic of your text…',
  },
  language: {
    tab: 'language', kind: 'ranked', results: 'language-results',
    hint: 'Identify the language of the page text.',
    analyzing: 'Identifying the language of your text…',
  },
  formality: {
    tab: 'formality', kind: 'ranked', results: 'formality-results',
    hint: 'Estimate whether the text is formal or informal.',
    analyzing: 'Estimating the formality of your text…',
  },
  factuality: {
    tab: 'factuality', kind: 'ranked', results: 'factuality-results',
    hint: 'Estimate whether the text is factual, opinion, or speculative.',
    analyzing: 'Estimating the factuality of your text…',
  },
  toxicity: {
    tab: 'toxicity', kind: 'ranked', results: 'toxicity-results',
    hint: 'Score the text for toxic content.',
    analyzing: 'Scoring the toxicity of your text…',
  },
  intent: {
    tab: 'intent', kind: 'ranked', results: 'intent-results',
    hint: 'Detect the user’s intent in the text.',
    analyzing: 'Detecting the intent of your text…',
  },
  action: {
    tab: 'actionItems', kind: 'ranked', results: 'action-results',
    hint: 'Detect actionable tasks mentioned in the page.',
    analyzing: 'Scanning your text for action items…', list: true,
  },
  zshot: {
    tab: 'zeroShot', kind: 'ranked', results: 'zshot-results',
    hint: 'Zero-shot classification with your own labels.',
    analyzing: 'Classifying your text…',
    input: { id: 'zshot-input', msg: 'Enter comma-separated labels.', required: true },
    args: (text, v) => [text, v.split(',').map((s) => s.trim()).filter(Boolean), false],
  },
  contradiction: {
    tab: 'contradiction', kind: 'ranked', results: 'contradiction-results',
    hint: 'Check a claim against the page for contradiction.',
    analyzing: 'Checking the claim against your text…',
    input: { id: 'claim-input', msg: 'Enter a claim to check.', required: true },
    args: (text, v) => [text, v],
  },
  // --- Batch 2: 20 more on-device features ---
  bias: {
    tab: 'bias', kind: 'ranked', results: 'bias-results',
    hint: 'Detect political, gender, or racial bias in the text.',
    analyzing: 'Detecting bias in your text…',
  },
  emotion: {
    tab: 'emotion', kind: 'ranked', results: 'emotion-results',
    hint: 'Read the fine-grained emotions in the text with the go_emotions classifier.',
    analyzing: 'Reading the emotions of your text…', max: 6, min: 0.04,
  },
  sarcasm: {
    tab: 'sarcasm', kind: 'ranked', results: 'sarcasm-results',
    hint: 'Estimate whether the text is sarcastic or literal.',
    analyzing: 'Estimating sarcasm in your text…',
  },
  urgency: {
    tab: 'urgency', kind: 'ranked', results: 'urgency-results',
    hint: 'Estimate the urgency level of the text.',
    analyzing: 'Estimating urgency in your text…',
  },
  politics: {
    tab: 'politics', kind: 'ranked', results: 'politics-results',
    hint: 'Estimate the political lean of the text.',
    analyzing: 'Estimating political lean in your text…',
  },
  age: {
    tab: 'age', kind: 'ranked', results: 'age-results',
    hint: 'Estimate the target audience age group.',
    analyzing: 'Estimating target audience age…',
  },
  genre: {
    tab: 'genre', kind: 'ranked', results: 'genre-results',
    hint: 'Detect the genre of the text (news, fiction, academic, …).',
    analyzing: 'Detecting the genre of your text…',
  },
  coherence: {
    tab: 'coherence', kind: 'text', out: 'out-coherence',
    hint: 'Score how consistently the text stays on one topic.',
    args: (text) => [text],
    render: (out, r) =>
      renderText(out, `Coherence score: ${(r.score * 100).toFixed(0)}% across ${r.sentences} sentences.\nHigher means the text stays on one consistent topic.`),
  },
  simplicity: {
    tab: 'simplicity', kind: 'text', out: 'out-simplicity',
    hint: 'Estimate how simple and readable the text is.',
    args: (text) => [text],
    render: (out, r) =>
      renderText(out, `Simplicity score: ${(r.score * 100).toFixed(0)}%\nAvg word length: ${r.avgWordLength}\nVocabulary spread: ${r.vocabularySpread}`),
  },
  duplicates: {
    tab: 'duplicates', kind: 'text', out: 'out-duplicates',
    hint: 'Find near-duplicate sentences in the text.',
    args: (text) => [text],
    render: (out, r) => {
      out.className = 'output';
      out.replaceChildren();
      for (const p of r.pairs || []) {
        const el = document.createElement('p');
        el.className = 'search-text';
        el.textContent = `“${p.a}” ≈ “${p.b}” (${Math.round(p.score * 100)}%)`;
        out.appendChild(el);
      }
    },
  },
  keyphrases: {
    tab: 'keyphrases', kind: 'text', out: 'out-keyphrases',
    hint: 'Extract the most central keyphrases from the text.',
    args: (text) => [text],
    render: (out, r) => renderText(out, (r.terms || []).map((t) => t.term).join(', ') || 'No keyphrases found.'),
  },
  faq: {
    tab: 'faq', kind: 'list', out: 'out-faq',
    hint: 'Find passages that read like answers to common questions.',
    args: (text) => [text],
    render: (out, r) => renderList(out, r.results),
  },
  claims: {
    tab: 'claims', kind: 'list', out: 'out-claims',
    hint: 'Extract factual claims made in the text.',
    args: (text) => [text],
    render: (out, r) => renderList(out, r.results),
  },
  quotes: {
    tab: 'quotes', kind: 'list', out: 'out-quotes',
    hint: 'Pull the most representative quotations from the text.',
    args: (text) => [text],
    render: (out, r) => renderList(out, r.results.map((x) => ({ text: `“${x.text}”` }))),
  },
  acronyms: {
    tab: 'acronyms', kind: 'text', out: 'out-acronyms',
    hint: 'Detect acronyms and their definitions in the text.',
    args: (text) => [text],
    render: (out, r) => {
      out.className = 'output';
      out.replaceChildren();
      for (const d of r.definitions || []) {
        const p = document.createElement('p');
        p.className = 'search-text';
        const a = document.createElement('span');
        a.style.color = 'var(--accent-hi)';
        a.style.fontWeight = '600';
        a.textContent = `${d.acronym}: `;
        const m = document.createElement('span');
        m.textContent = d.meaning;
        p.append(a, m);
        out.appendChild(p);
      }
      if ((r.entities || []).length) {
        const p = document.createElement('p');
        p.className = 'search-text';
        p.style.color = 'var(--fg-dim)';
        p.textContent = `Entities: ${(r.entities || []).map((e) => e.word).join(', ')}`;
        out.appendChild(p);
      }
    },
  },
  numbers: {
    tab: 'numbers', kind: 'text', out: 'out-numbers',
    hint: 'Extract numbers and statistics from the text.',
    args: (text) => [text],
    render: (out, r) => renderText(out, (r.numbers || []).join('\n') || 'No numbers found.'),
  },
  dates: {
    tab: 'dates', kind: 'text', out: 'out-dates',
    hint: 'Extract dates mentioned in the text.',
    args: (text) => [text],
    render: (out, r) => renderText(out, (r.dates || []).join('\n') || 'No dates found.'),
  },
  persons: {
    tab: 'persons', kind: 'text', out: 'out-persons',
    hint: 'Extract the names of people mentioned in the text.',
    args: (text) => [text],
    render: (out, r) => renderText(out, (r.persons || []).join(', ') || 'No people found.'),
  },
  places: {
    tab: 'places', kind: 'text', out: 'out-places',
    hint: 'Extract the locations mentioned in the text.',
    args: (text) => [text],
    render: (out, r) => renderText(out, (r.places || []).join(', ') || 'No places found.'),
  },
  orgs: {
    tab: 'orgs', kind: 'text', out: 'out-orgs',
    hint: 'Extract the organizations mentioned in the text.',
    args: (text) => [text],
    render: (out, r) => renderText(out, (r.orgs || []).join(', ') || 'No organizations found.'),
  },
};

// ---------------------------------------------------------------------------
// Central dispatcher — every feature runs through here.
// ---------------------------------------------------------------------------

async function runFeature(name) {
  const cfg = FEATURES[name];
  if (!cfg) return;

  // Read + validate any required input field (question, query, labels, …).
  let inputVal = '';
  if (cfg.input) {
    const el = $(`#${cfg.input.id}`);
    inputVal = el ? el.value.trim() : '';
    if (cfg.input.required && !inputVal) {
      toast(cfg.input.msg, 'error');
      if (el) el.focus();
      return;
    }
  }

  const text = await getAnalysisText();
  if (!text) {
    const target = cfg.kind === 'ranked' ? $(`#${cfg.results}`) : $(`#${cfg.out}`);
    showNoText(target);
    return;
  }
  if (!engineReady) {
    try {
      await initEngine();
      engineReady = true;
    } catch (err) {
      toast(err.message || 'The AI engine is not ready yet.', 'error');
      return;
    }
  }

  const limit = INPUT_LIMIT[cfg.tab];
  if (typeof limit === 'number' && text.length > limit) {
    const target = cfg.kind === 'ranked' ? $(`#${cfg.results}`) : $(`#${cfg.out}`);
    showContextWarning(target, text.length, limit);
    return;
  }

  // Prepare the output area for the run.
  const out = cfg.kind === 'ranked' ? $(`#${cfg.results}`) : $(`#${cfg.out}`);
  if (cfg.kind === 'ranked') {
    out.replaceChildren();
    const p = document.createElement('p');
    p.className = 'tone-empty';
    p.textContent = cfg.analyzing || 'Analyzing…';
    out.appendChild(p);
  } else {
    out.className = 'output thinking';
    out.textContent = 'Analyzing on-device…';
  }

  setBusy(true);
  try {
    const args = (cfg.args || ((t) => [t]))(text, inputVal);
    const promise = ai[cfg.tab](...args);
    setActiveRequestId(promise.requestId || null);
    const result = await promise;
    renderResult(cfg, result, { text, inputVal, question: inputVal });
  } catch (err) {
    if (out) {
      if (err.message && err.message.startsWith('No ')) {
        showEmptyMessage(out, err.message);
      } else {
        out.className = 'output error';
        out.textContent = err.message || 'Something went wrong.';
      }
    }
  } finally {
    // Always clear the active request + progress UI, whether the run finished,
    // failed, or was cancelled via the Stop button.
    setActiveRequestId(null);
    resetProgress();
    setBusy(false);
  }
}

// Paint an engine result according to the feature's kind.
function renderResult(cfg, result, ctx) {
  switch (cfg.kind) {
    case 'ranked': {
      const out = $(`#${cfg.results}`);
      if (cfg.list) renderActionList(out, result);
      else renderToneBars(out, extractRanked(result), { max: cfg.max, min: cfg.min });
      break;
    }
    case 'search':
      renderSearchResults($(`#${cfg.out}`), result.results || []);
      break;
    case 'qa':
    case 'text':
    case 'list':
    default:
      if (cfg.render) cfg.render($(`#${cfg.out}`), result, ctx);
      break;
  }
}

// Public alias used by the menu commands in renderer.js.
export function runFeatureByName(name) {
  runFeature(name);
}

// Re-render the history list (called when the History panel is opened so it
// reflects the latest navigations recorded in IndexedDB).
export function refreshHistory() {
  if (FEATURES.history) renderHistoryPanel();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// Wire the Enter key inside every feature's input field so pressing Enter runs
// the task (same as clicking "Run …"). The Run buttons themselves are generated
// by buildPanels() and wired there.
export function initHeadlineFeatures() {
  for (const [name, cfg] of Object.entries(FEATURES)) {
    if (cfg && cfg.input) {
      const el = $(`#${cfg.input.id}`);
      if (el) el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); runFeature(name); }
      });
    }
  }
}

// History panel: a custom, non-AI feature rendered like the others. It lists
// visits from IndexedDB with per-row delete, a filter box, and a clear-all.
function buildHistoryPanel(name, cfg) {
  const panel = document.createElement('section');
  panel.className = 'feature-panel';
  panel.dataset.panel = name;
  panel.setAttribute('role', 'tabpanel');

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = cfg.hint || '';
  panel.appendChild(hint);

  const toolbar = document.createElement('div');
  toolbar.className = 'history-toolbar';
  const search = document.createElement('input');
  search.type = 'text';
  search.id = 'history-search';
  search.placeholder = 'Filter by URL or title…';
  search.spellcheck = false;
  search.autocomplete = 'off';
  const clear = document.createElement('button');
  clear.className = 'btn ghost square';
  clear.id = 'btn-history-clear';
  clear.title = 'Clear all history';
  clear.innerHTML = '<svg class="ic"><use href="#i-trash" /></svg>';
  toolbar.append(search, clear);
  panel.appendChild(toolbar);

  const list = document.createElement('div');
  list.className = 'history-list';
  list.id = 'history-list';
  panel.appendChild(list);

  search.addEventListener('input', renderHistoryPanel);
  clear.addEventListener('click', async () => {
    if (!confirm('Clear all browsing history?')) return;
    await clearHistory();
    renderHistoryPanel();
  });
  list.addEventListener('click', async (e) => {
    const del = e.target.closest('.history-del');
    if (del) {
      e.stopPropagation();
      await deleteHistory(del.dataset.url);
      renderHistoryPanel();
      return;
    }
    const item = e.target.closest('.history-item');
    if (item && tabsRef) tabsRef.open(item.dataset.url);
  });

  // Populate the list immediately so it's ready when the panel is opened.
  renderHistoryPanel();
  return panel;
}

// Render (or re-render) the history list into the panel. Wired to the panel's
// own filter/clear controls; clicking a row reopens that URL in the active tab.
function renderHistoryPanel() {
  const list = $('#history-list');
  if (!list) return;
  const filter = ($('#history-search')?.value || '').trim().toLowerCase();

  list.replaceChildren();
  getHistory().then((items) => {
    const filtered = filter
      ? items.filter(
          (h) =>
            h.url.toLowerCase().includes(filter) ||
            (h.title || '').toLowerCase().includes(filter)
        )
      : items;

    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = items.length ? 'No matches.' : 'No history yet.';
      list.appendChild(empty);
      return;
    }

    for (const h of filtered) {
      const el = document.createElement('div');
      el.className = 'history-item';
      el.dataset.url = h.url;
      el.title = h.url;

      const fav = document.createElement('span');
      fav.className = 'history-fav';
      if (h.favicon) {
        const img = document.createElement('img');
        img.src = h.favicon;
        img.addEventListener('error', () => img.remove());
        fav.appendChild(img);
      }

      const body = document.createElement('div');
      body.className = 'history-body';
      const title = document.createElement('div');
      title.className = 'history-title';
      title.textContent = h.title || h.url;
      const url = document.createElement('div');
      url.className = 'history-url';
      url.textContent = h.url;
      body.append(title, url);

      const del = document.createElement('button');
      del.className = 'history-del';
      del.dataset.url = h.url;
      del.title = 'Delete from history';
      del.innerHTML = '<svg class="ic"><use href="#i-trash" /></svg>';

      el.append(fav, body, del);
      list.appendChild(el);
    }
  });
}

// Build every feature panel from the FEATURES registry. This keeps index.html
// free of ~40 near-identical <section> blocks: each panel gets a hint, an
// optional input field, an output area (`.output` + copy button for text/list/
// qa/search kinds, `.tone-results` for ranked kinds), and a single Run button.
function buildPanels(body) {
  for (const [name, cfg] of Object.entries(FEATURES)) {
    if (cfg.custom === 'history') {
      body.appendChild(buildHistoryPanel(name, cfg));
      continue;
    }
    const panel = document.createElement('section');
    panel.className = 'feature-panel';
    panel.dataset.panel = name;
    panel.setAttribute('role', 'tabpanel');

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = cfg.hint || '';
    panel.appendChild(hint);

    if (cfg.input) {
      const input = document.createElement('input');
      input.id = cfg.input.id;
      input.type = 'text';
      input.placeholder = cfg.input.ph || `Enter ${name}…`;
      panel.appendChild(input);
    }

    if (cfg.kind === 'ranked') {
      const results = document.createElement('div');
      results.className = 'tone-results';
      results.id = cfg.results;
      const empty = document.createElement('p');
      empty.className = 'tone-empty';
      empty.textContent = 'Select some text on the page, then click Run. The model’s read appears here.';
      results.appendChild(empty);
      panel.appendChild(results);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'output-wrap';
      const out = document.createElement('div');
      out.className = 'output';
      out.id = cfg.out;
      out.dataset.placeholder = 'Results appear here.';
      wrap.appendChild(out);
      const copy = document.createElement('button');
      copy.className = 'copy-btn';
      copy.dataset.copy = cfg.out;
      copy.title = 'Copy';
      copy.innerHTML = '<svg class="ic"><use href="#i-copy" /></svg>';
      wrap.appendChild(copy);
      panel.appendChild(wrap);
    }

    const btn = document.createElement('button');
    btn.className = 'btn primary grow feature-run';
    btn.id = `btn-${name}`;
    btn.innerHTML = `<svg class="ic"><use href="#i-sparkle" /></svg> Run ${FEATURE_TITLES[name] || name}`;
    btn.addEventListener('click', () => runFeature(name));
    panel.appendChild(btn);

    body.appendChild(panel);
  }
}

export function initFeatureLaunchers() {
  // Clicking a launcher card only opens the feature's modal. The AI task is NOT
  // triggered here — it runs only when the user clicks "Run …" or presses Enter
  // inside the modal (see buildPanels + initHeadlineFeatures).
  $$('.feature-card').forEach((card) => {
    card.addEventListener('click', () => {
      const name = card.dataset.feature;
      const use = card.querySelector('.feature-ic use');
      openFeature(name, use ? use.getAttribute('href') : null);
    });
  });

  // Generate the panels once from the registry (replacing the old static HTML).
  buildPanels($('#ai-modal-body'));
}

export { runFeature };
