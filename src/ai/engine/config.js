// AI engine configuration: model registry, pipeline task mapping, per-task
// input ceilings, and human-readable labels.
//
// Centralising these tables keeps the handlers (see handlers.js) free of
// magic strings and makes adding a new on-device feature a one-line change.
// PIPELINE_TASK and LABELS are derived from MODELS + META so they never drift.

// task -> model id
const MODELS = {
  summarization: 'Xenova/distilbart-cnn-6-6',
  'question-answering': 'Xenova/distilbert-base-cased-distilled-squad',
  'feature-extraction': 'Xenova/all-MiniLM-L6-v2',
  'search': 'Xenova/all-MiniLM-L6-v2',
  'text-classification': 'MicahB/roberta-base-go_emotions',
  // --- New on-device models (no text generation, no translation) ---
  'token-classification': 'Xenova/bert-base-NER',
  'zero-shot-classification': 'Xenova/distilbert-base-uncased-mnli',
  'sentiment': 'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
  'toxicity': 'Xenova/toxic-bert',
  'reading-time': 'Xenova/all-MiniLM-L6-v2',
  'keywords': 'Xenova/all-MiniLM-L6-v2',
  'cluster': 'Xenova/all-MiniLM-L6-v2',
  'dedupe': 'Xenova/all-MiniLM-L6-v2',
  'related': 'Xenova/all-MiniLM-L6-v2',
  'topic': 'Xenova/distilbert-base-uncased-mnli',
  'intent': 'Xenova/distilbert-base-uncased-mnli',
  'formality': 'Xenova/distilbert-base-uncased-mnli',
  'language': 'Xenova/distilbert-base-uncased-mnli',
  'factuality': 'Xenova/distilbert-base-uncased-mnli',
  'action-items': 'Xenova/all-MiniLM-L6-v2',
  'questions': 'Xenova/distilbert-base-cased-distilled-squad',
  'glossary': 'Xenova/all-MiniLM-L6-v2',
  'outline': 'Xenova/all-MiniLM-L6-v2',
  'contradiction': 'Xenova/distilbert-base-uncased-mnli',
  'highlight': 'Xenova/all-MiniLM-L6-v2',
  // --- Batch 2: 20 more on-device features (no text generation) ---
  'bias': 'Xenova/distilbert-base-uncased-mnli',
  'emotion': 'MicahB/roberta-base-go_emotions',
  'sarcasm': 'Xenova/distilbert-base-uncased-mnli',
  'urgency': 'Xenova/distilbert-base-uncased-mnli',
  'politics': 'Xenova/distilbert-base-uncased-mnli',
  'age': 'Xenova/distilbert-base-uncased-mnli',
  'genre': 'Xenova/distilbert-base-uncased-mnli',
  'coherence': 'Xenova/all-MiniLM-L6-v2',
  'simplicity': 'Xenova/all-MiniLM-L6-v2',
  'duplicates': 'Xenova/all-MiniLM-L6-v2',
  'keyphrases': 'Xenova/all-MiniLM-L6-v2',
  'faq': 'Xenova/all-MiniLM-L6-v2',
  'claims': 'Xenova/all-MiniLM-L6-v2',
  'quotes': 'Xenova/all-MiniLM-L6-v2',
  'acronyms': 'Xenova/bert-base-NER',
  'numbers': 'Xenova/all-MiniLM-L6-v2',
  'dates': 'Xenova/all-MiniLM-L6-v2',
  'persons': 'Xenova/bert-base-NER',
  'places': 'Xenova/bert-base-NER',
  'orgs': 'Xenova/bert-base-NER',
};

// Per-model metadata: which pipeline task it runs under, and the human label
// used in progress messages. Everything else is derived from this.
const META = {
  'Xenova/distilbart-cnn-6-6': { pipeline: 'summarization', label: 'summarizer' },
  'Xenova/distilbert-base-cased-distilled-squad': { pipeline: 'question-answering', label: 'question answering model' },
  'Xenova/all-MiniLM-L6-v2': { pipeline: 'feature-extraction', label: 'embedding model' },
  'MicahB/roberta-base-go_emotions': { pipeline: 'text-classification', label: 'emotion classifier' },
  'Xenova/bert-base-NER': { pipeline: 'token-classification', label: 'named-entity recognizer' },
  'Xenova/distilbert-base-uncased-mnli': { pipeline: 'zero-shot-classification', label: 'zero-shot classifier' },
  'Xenova/distilbert-base-uncased-finetuned-sst-2-english': { pipeline: 'text-classification', label: 'sentiment classifier' },
  'Xenova/toxic-bert': { pipeline: 'text-classification', label: 'toxicity classifier' },
};

// Derive PIPELINE_TASK and LABELS from MODELS + META so they cannot drift apart.
const PIPELINE_TASK = {};
const LABELS = {};
for (const [task, model] of Object.entries(MODELS)) {
  const meta = META[model];
  if (!meta) throw new Error(`No META entry for model "${model}" (task "${task}").`);
  PIPELINE_TASK[task] = meta.pipeline;
  LABELS[task] = meta.label;
}

// Per-task input ceilings (characters) grouped by pipeline type. These stay
// within each model's token window; the full page text is captured and the
// engine fits as much as each model can use. Summarize chunks across the whole
// input; ask/search use the clamped lead portion.
const LIMIT_BY_PIPELINE = {
  summarization: 3500,
  'question-answering': 6000,
  'feature-extraction': 2000,
  'search': 2000,
  'text-classification': 512,
  'token-classification': 1500,
  'zero-shot-classification': 1500,
};

// Tasks that need the larger embedding/extraction window (4000) or the
// 3000 keyword window — overrides applied on top of the pipeline default.
const LIMIT_OVERRIDES = {
  'reading-time': 4000,
  'keywords': 3000,
  'cluster': 4000,
  'dedupe': 4000,
  'related': 4000,
  'action-items': 4000,
  'questions': 6000,
  'glossary': 4000,
  'outline': 4000,
  'contradiction': 1500,
  'intent': 512,
  'formality': 512,
  'language': 512,
  'highlight': 4000,
  'coherence': 4000,
  'simplicity': 4000,
  'duplicates': 4000,
  'keyphrases': 3000,
  'faq': 4000,
  'claims': 4000,
  'quotes': 4000,
  'acronyms': 1500,
  'numbers': 4000,
  'dates': 4000,
  'persons': 1500,
  'places': 1500,
  'orgs': 1500,
};

const INPUT_LIMIT = {};
for (const [task, model] of Object.entries(MODELS)) {
  INPUT_LIMIT[task] = LIMIT_OVERRIDES[task] ?? LIMIT_BY_PIPELINE[META[model].pipeline];
}

module.exports = { MODELS, PIPELINE_TASK, INPUT_LIMIT, LABELS };
