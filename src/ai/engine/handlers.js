// AI task handlers.
//
// Each handler receives a ready pipeline plus the request `inputs`/`options`
// and returns a plain, serialisable result object. Handlers never touch model
// loading or progress — that is the engine's job (see engine.js).

const { clamp, chunk, sentences, cosine, tensorToVectors, centroid, normalizeRanked, rankClassification } =
  require('./util.js');

// ---------------------------------------------------------------------------
// Summarization / QA / embeddings
// ---------------------------------------------------------------------------

async function runSummarize(pipe, inputs, options, id, emit) {
  const chunks = chunk(inputs.text, 3500).slice(0, 4);
  if (!chunks.length) throw new Error('There is no readable text on this page.');

  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) {
      emit({
        phase: 'work',
        label: `Summarizing section ${i + 1} of ${chunks.length}`,
        percent: Math.round((i / chunks.length) * 100),
      });
    }
    const out = await pipe(chunks[i], {
      max_new_tokens: options.maxNewTokens || 130,
      min_length: options.minLength || 30,
      do_sample: false,
    });
    partials.push((out[0]?.summary_text || '').trim());
  }

  let summary = partials.filter(Boolean).join(' ');
  if (partials.length > 1 && summary.length > 400) {
    emit({ phase: 'work', label: 'Condensing summary', percent: 90 });
    const out = await pipe(clamp(summary, 'summarization'), {
      max_new_tokens: options.maxNewTokens || 150,
      min_length: 40,
      do_sample: false,
    });
    summary = (out[0]?.summary_text || summary).trim();
  }

  if (!summary) throw new Error('The model returned an empty summary.');
  return { summary, sections: partials.length };
}

async function runAsk(pipe, inputs) {
  const question = (inputs.question || '').trim();
  if (!question) throw new Error('Please enter a question.');

  const context = clamp(inputs.context, 'question-answering');
  if (!context) throw new Error('There is no readable text on this page.');

  const out = await pipe(question, context, { topk: 1 });
  const best = Array.isArray(out) ? out[0] : out;
  const answer = (best?.answer || '').trim();
  if (!answer) throw new Error('No answer could be found on this page.');
  return { answer, score: typeof best?.score === 'number' ? best.score : null };
}

async function runEmbed(pipe, inputs) {
  const text = clamp(inputs.text, 'feature-extraction');
  if (!text) throw new Error('No text to embed.');
  const out = await pipe(text, { pooling: 'mean', normalize: true });
  return { embedding: Array.from(out.data) };
}

// ---------------------------------------------------------------------------
// Semantic search / classification
// ---------------------------------------------------------------------------

async function runSearch(pipe, inputs) {
  const query = (inputs.query || '').trim();
  const passages = Array.isArray(inputs.passages) ? inputs.passages : [];
  if (!query) throw new Error('Please type something to search for.');
  if (!passages.length) throw new Error('There is no text to search.');

  // Embed the query together with every passage in a single batch so the
  // model runs once. all-MiniLM returns L2-normalized vectors, so cosine
  // similarity equals the dot product.
  const batch = [query, ...passages];
  const out = await pipe(batch, { pooling: 'mean', normalize: true });
  const vectors = tensorToVectors(out);

  const queryVec = vectors[0];
  const results = passages
    .map((text, i) => ({ text, score: cosine(queryVec, vectors[i + 1]) }))
    .filter((r) => r.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (!results.length) throw new Error('No relevant passages found.');
  return { results };
}

// Generic single-label text classifier (go_emotions / sst-2 / toxic-bert all
// return a ranked label list). Used by runClassify/runSentiment/runToxicity/
// runEmotion, which only differ by their clamp task.
async function runTextClassify(pipe, inputs, task) {
  const text = clamp(inputs.text, task);
  if (!text) throw new Error('No text to analyze.');
  const ranked = rankClassification(await pipe(text, { topk: null }));
  if (!ranked.length) throw new Error('The model returned no classification.');
  return { labels: ranked };
}

const runClassify = (pipe, inputs) => runTextClassify(pipe, inputs, 'text-classification');

// ---------------------------------------------------------------------------
// Named-entity recognition
// ---------------------------------------------------------------------------

async function runNer(pipe, inputs) {
  const text = clamp(inputs.text, 'token-classification');
  if (!text) throw new Error('No text to analyze.');
  const out = await pipe(text, { aggregation_strategy: 'simple' });
  const entities = (Array.isArray(out) ? out : []).map((e) => ({
    entity: e.entity_group || e.entity || '',
    word: (e.word || '').replace(/^##/, ''),
    score: typeof e.score === 'number' ? e.score : 0,
  }));
  if (!entities.length) throw new Error('No named entities found in this text.');
  return { entities };
}

// ---------------------------------------------------------------------------
// Zero-shot + single-label classifiers
// ---------------------------------------------------------------------------

async function runZeroShot(pipe, inputs) {
  const text = clamp(inputs.text, 'zero-shot-classification');
  const labels = Array.isArray(inputs.labels) ? inputs.labels : [];
  if (!text) throw new Error('No text to classify.');
  if (!labels.length) throw new Error('No candidate labels were provided.');
  const out = await pipe(text, labels, { multi_label: Boolean(inputs.multiLabel) });
  const ranked = normalizeRanked(out);
  if (!ranked.length) throw new Error('The model returned no classification.');
  return { labels: ranked };
}

const runSentiment = (pipe, inputs) => runTextClassify(pipe, inputs, 'sentiment');
const runToxicity = (pipe, inputs) => runTextClassify(pipe, inputs, 'toxicity');

// ---------------------------------------------------------------------------
// Embedding-derived features
// ---------------------------------------------------------------------------

async function runReadingTime(pipe, inputs) {
  const text = clamp(inputs.text, 'reading-time');
  if (!text) throw new Error('No text to measure.');
  const words = text.split(/\s+/).filter(Boolean).length;
  const wpm = 220;
  const minutes = Math.max(1, Math.round(words / wpm));
  // Use the embedding model to estimate information density (avg vector
  // magnitude as a proxy for lexical richness).
  const out = await pipe(text, { pooling: 'mean', normalize: true });
  const vec = Array.from(out.data);
  const density = vec.reduce((a, b) => a + Math.abs(b), 0) / vec.length;
  return { words, minutes, wpm, density: Number(density.toFixed(4)) };
}

async function runKeywords(pipe, inputs) {
  const text = clamp(inputs.text, 'keywords');
  if (!text) throw new Error('No text to analyze.');
  const sentences = chunk(text, 400);
  if (!sentences.length) throw new Error('No text to analyze.');
  const out = await pipe(sentences, { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  const c = centroid(vecs);
  const scored = sentences
    .map((s, i) => ({ s, score: cosine(c, vecs[i]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  // Pull short, capitalized or quoted tokens as keyword candidates.
  const words = new Set();
  for (const { s } of scored) {
    const m = s.match(/\b([A-Z][a-zA-Z]{3,}|"[^"]+"|'[^']+')/g) || [];
    m.forEach((w) => words.add(w.replace(/["']/g, '')));
  }
  const keywords = [...words].slice(0, 12);
  if (!keywords.length) throw new Error('Could not extract keywords from this text.');
  return { keywords, sentences: scored.map((x) => x.s) };
}

async function runCluster(pipe, inputs) {
  const text = clamp(inputs.text, 'cluster');
  const k = Math.min(Math.max(Number(inputs.clusters) || 4, 2), 8);
  if (!text) throw new Error('No text to cluster.');
  const sentences = chunk(text, 300).slice(0, 40);
  if (sentences.length < k) throw new Error('Not enough text to form clusters.');
  const out = await pipe(sentences, { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  // Greedy k-means++ style seeding.
  const centers = [vecs[0].slice()];
  while (centers.length < k) {
    let best = -1;
    let bestD = -1;
    vecs.forEach((v, i) => {
      const d = Math.min(...centers.map((c) => 1 - cosine(v, c)));
      if (d > bestD) { bestD = d; best = i; }
    });
    if (best >= 0) centers.push(vecs[best].slice());
    else break;
  }
  const groups = centers.map(() => []);
  vecs.forEach((v, i) => {
    let bi = 0;
    let bs = -2;
    centers.forEach((c, ci) => {
      const s = cosine(v, c);
      if (s > bs) { bs = s; bi = ci; }
    });
    groups[bi].push(sentences[i]);
  });
  return {
    clusters: groups
      .map((items, i) => ({ id: i, items, size: items.length }))
      .filter((g) => g.size > 0),
  };
}

async function runDedupe(pipe, inputs) {
  const text = clamp(inputs.text, 'dedupe');
  const threshold = typeof inputs.threshold === 'number' ? inputs.threshold : 0.92;
  if (!text) throw new Error('No text to dedupe.');
  const sentences = chunk(text, 300);
  if (!sentences.length) throw new Error('No text to dedupe.');
  const out = await pipe(sentences, { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  const kept = [];
  const seen = [];
  sentences.forEach((s, i) => {
    const dup = seen.some((j) => cosine(vecs[i], vecs[j]) >= threshold);
    if (!dup) { kept.push(s); seen.push(i); }
  });
  return { kept, removed: sentences.length - kept.length, total: sentences.length };
}

async function runRelated(pipe, inputs) {
  const ref = (inputs.reference || '').trim();
  const corpus = (inputs.text || '').trim();
  if (!ref) throw new Error('Provide a reference snippet to compare against.');
  if (!corpus) throw new Error('No text to compare.');
  const passages = chunk(corpus, 300);
  const batch = [ref, ...passages];
  const out = await pipe(batch, { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  const results = passages
    .map((text, i) => ({ text, score: cosine(vecs[0], vecs[i + 1]) }))
    .filter((r) => r.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  if (!results.length) throw new Error('No related passages found.');
  return { results };
}

// ---------------------------------------------------------------------------
// Zero-shot topic / intent / formality / language / factuality
// ---------------------------------------------------------------------------

// Single generic zero-shot runner, data-driven by a labels table below. Each
// entry maps a task name to the candidate labels the MNLI model scores.
const ZEROSHOT_LABELS = {
  topic: [
    'technology', 'science', 'business', 'health', 'sports',
    'politics', 'entertainment', 'education', 'travel', 'food',
  ],
  intent: [
    'question', 'request', 'complaint', 'praise', 'suggestion',
    'command', 'greeting', 'farewell', 'informational',
  ],
  formality: ['formal', 'informal'],
  language: [
    'English', 'Spanish', 'French', 'German', 'Italian',
    'Portuguese', 'Dutch', 'Russian', 'Chinese', 'Japanese',
    'Korean', 'Arabic', 'Hindi', 'Turkish', 'Polish',
  ],
  factuality: ['factual', 'opinion', 'speculative'],
  sarcasm: ['sarcastic', 'literal'],
  urgency: ['low urgency', 'medium urgency', 'high urgency'],
  politics: ['left-leaning', 'center', 'right-leaning', 'non-political'],
  age: ['children', 'teenagers', 'young adults', 'adults', 'seniors'],
  genre: ['news', 'fiction', 'academic', 'technical', 'marketing', 'personal'],
};

async function runZeroShotLabels(pipe, inputs, task) {
  const text = clamp(inputs.text, task);
  if (!text) throw new Error('No text to classify.');
  const labels = ZEROSHOT_LABELS[task];
  if (!labels) throw new Error(`No labels configured for "${task}".`);
  const out = await pipe(text, labels, { multi_label: false });
  return { labels: normalizeRanked(out) };
}

const runTopic = (pipe, inputs) => runZeroShotLabels(pipe, inputs, 'topic');
const runIntent = (pipe, inputs) => runZeroShotLabels(pipe, inputs, 'intent');
const runFormality = (pipe, inputs) => runZeroShotLabels(pipe, inputs, 'formality');
const runLanguage = (pipe, inputs) => runZeroShotLabels(pipe, inputs, 'language');
const runFactuality = (pipe, inputs) => runZeroShotLabels(pipe, inputs, 'factuality');

// ---------------------------------------------------------------------------
// Action items / questions / glossary / outline / contradiction / highlight
// ---------------------------------------------------------------------------

async function runActionItems(pipe, inputs) {
  const text = clamp(inputs.text, 'action-items');
  if (!text) throw new Error('No text to scan.');
  const sentences = chunk(text, 300);
  const templates = [
    'you should complete this task',
    'please finish the work',
    'we need to do this',
    'remember to send the email',
    'todo: implement the feature',
    'action required before deadline',
    'submit the report by friday',
    'call the client tomorrow',
    'schedule a meeting with the team',
    'review the document and approve it',
    'make sure to complete the assignment',
  ];
  const batch = [...templates, ...sentences];
  const out = await pipe(batch, { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  const tVecs = vecs.slice(0, templates.length);
  const results = sentences
    .map((s, i) => {
      const score = Math.max(...tVecs.map((t) => cosine(t, vecs[templates.length + i])));
      return { text: s, score };
    })
    .filter((r) => r.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  if (!results.length) throw new Error('No clear action items detected.');
  return { results };
}

// Question generation: treat each sentence as context and ask the QA model to
// produce a plausible question (we surface the context as a study prompt).
async function runQuestions(pipe, inputs) {
  const text = clamp(inputs.text, 'questions');
  if (!text) throw new Error('No text to turn into questions.');
  const sentences = chunk(text, 400).slice(0, 6);
  const results = [];
  for (const ctx of sentences) {
    try {
      const out = await pipe('What is being described here?', ctx, { topk: 1 });
      const best = Array.isArray(out) ? out[0] : out;
      results.push({ context: ctx, question: best?.answer || 'What is this about?' });
    } catch {
      /* skip sentence */
    }
  }
  if (!results.length) throw new Error('Could not generate questions from this text.');
  return { results };
}

// Glossary: pull defined terms (word followed by "—" or ":" or "is/means")
// and rank them by embedding centrality.
async function runGlossary(pipe, inputs) {
  const text = clamp(inputs.text, 'glossary');
  if (!text) throw new Error('No text to scan.');
  const defRe = /([A-Z][a-zA-Z0-9\- ]{2,40})\s*(?:\([^)]*\))?\s*(?:[-–—:]|is|means|refers to)\s+([^.]{6,160})/g;
  const pairs = [];
  let m;
  while ((m = defRe.exec(text)) && pairs.length < 40) {
    pairs.push({ term: m[1].trim(), definition: m[2].trim() });
  }
  if (!pairs.length) throw new Error('No definitions (term: meaning) found in this text.');
  const out = await pipe(pairs.map((p) => p.term), { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  const c = centroid(vecs);
  const ranked = pairs
    .map((p, i) => ({ ...p, score: cosine(c, vecs[i]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  return { terms: ranked };
}

// Outline: group sentences into a hierarchical-ish outline by embedding
// similarity to section seeds derived from the first sentences.
async function runOutline(pipe, inputs) {
  const text = clamp(inputs.text, 'outline');
  if (!text) throw new Error('No text to outline.');
  const sentences = chunk(text, 300).slice(0, 50);
  if (sentences.length < 3) throw new Error('Not enough text to outline.');
  const out = await pipe(sentences, { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  // Build up to 5 sections greedily.
  const sections = [];
  const used = new Set();
  for (let i = 0; i < sentences.length && sections.length < 5; i++) {
    if (used.has(i)) continue;
    const seed = vecs[i];
    const group = [i];
    used.add(i);
    for (let j = 0; j < sentences.length; j++) {
      if (used.has(j)) continue;
      if (cosine(seed, vecs[j]) > 0.55) { group.push(j); used.add(j); }
    }
    sections.push({
      title: sentences[i].slice(0, 80),
      points: group.map((g) => sentences[g]).slice(0, 4),
    });
  }
  return { sections };
}

// Contradiction detection via natural-language-inference (NLI). The page text
// is the premise and the user's claim is the hypothesis; the MNLI model scores
// the three relations (entailment / neutral / contradiction) between them.
async function runContradiction(pipe, inputs) {
  const claim = (inputs.claim || '').trim();
  const context = clamp(inputs.text, 'contradiction');
  if (!claim) throw new Error('Provide a claim to check.');
  if (!context) throw new Error('No text to check against.');
  const out = await pipe(context, ['entailment', 'neutral', 'contradiction'], { multi_label: false });
  return { labels: normalizeRanked(out) };
}

// Highlight: score each sentence by centrality to the document and return the
// most important ones as highlights.
async function runHighlight(pipe, inputs) {
  const text = clamp(inputs.text, 'highlight');
  if (!text) throw new Error('No text to highlight.');
  const sentences = chunk(text, 300);
  if (!sentences.length) throw new Error('No text to highlight.');
  const out = await pipe(sentences, { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  const c = centroid(vecs);
  const results = sentences
    .map((s, i) => ({ text: s, score: cosine(c, vecs[i]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return { results };
}

// ---------------------------------------------------------------------------
// Batch 2: 20 more on-device features (no text generation)
// ---------------------------------------------------------------------------

// Bias detection via zero-shot NLI over common bias dimensions.
async function runBias(pipe, inputs) {
  const text = clamp(inputs.text, 'bias');
  if (!text) throw new Error('No text to analyze.');
  const labels = ['political bias', 'gender bias', 'racial bias', 'neutral'];
  const out = await pipe(text, labels, { multi_label: true });
  return { labels: normalizeRanked(out) };
}

// Fine-grained emotion read using the go_emotions classifier (topk).
const runEmotion = (pipe, inputs) => runTextClassify(pipe, inputs, 'emotion');

// Sarcasm detection via zero-shot over tone dimensions.
const runSarcasm = (pipe, inputs) => runZeroShotLabels(pipe, inputs, 'sarcasm');

// Urgency estimation via zero-shot over urgency levels.
const runUrgency = (pipe, inputs) => runZeroShotLabels(pipe, inputs, 'urgency');

// Political lean estimation via zero-shot.
const runPolitics = (pipe, inputs) => runZeroShotLabels(pipe, inputs, 'politics');

// Target audience age via zero-shot.
const runAge = (pipe, inputs) => runZeroShotLabels(pipe, inputs, 'age');

// Text genre via zero-shot.
const runGenre = (pipe, inputs) => runZeroShotLabels(pipe, inputs, 'genre');

// Coherence: how tightly the sentences cluster around the document centroid.
async function runCoherence(pipe, inputs) {
  const text = clamp(inputs.text, 'coherence');
  if (!text) throw new Error('No text to measure.');
  const sentences = chunk(text, 300);
  if (sentences.length < 2) throw new Error('Not enough text to score coherence.');
  const out = await pipe(sentences, { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  const c = centroid(vecs);
  const sims = vecs.map((v) => cosine(c, v));
  const avg = sims.reduce((a, b) => a + b, 0) / sims.length;
  return { score: Number(avg.toFixed(4)), sentences: sentences.length };
}

// Simplicity: lexical simplicity proxy from average token length + embedding
// spread (lower spread = more uniform/simpler vocabulary).
async function runSimplicity(pipe, inputs) {
  const text = clamp(inputs.text, 'simplicity');
  if (!text) throw new Error('No text to measure.');
  const words = text.split(/\s+/).filter(Boolean);
  const avgWord = words.reduce((a, w) => a + w.length, 0) / Math.max(1, words.length);
  const sentences = chunk(text, 300);
  const out = await pipe(sentences, { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  const c = centroid(vecs);
  const spread = vecs.reduce((a, v) => a + (1 - cosine(c, v)), 0) / vecs.length;
  const score = Number(Math.max(0, 1 - (avgWord / 12) - spread).toFixed(4));
  return { score, avgWordLength: Number(avgWord.toFixed(2)), vocabularySpread: Number(spread.toFixed(4)) };
}

// Duplicate sentence finder (near-duplicate pairs above a threshold).
async function runDuplicates(pipe, inputs) {
  const text = clamp(inputs.text, 'duplicates');
  if (!text) throw new Error('No text to scan.');
  const sents = sentences(text);
  if (sents.length < 2) throw new Error('Not enough text to compare.');

  // Exact duplicates: identical once normalised (case/space/punctuation
  // stripped). This is the most reliable signal and needs no model.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = new Map(); // normalized -> first sentence
  const pairs = [];
  const toks = sents.map((s) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) || []));

  for (let i = 0; i < sents.length; i++) {
    const n = norm(sents[i]);
    if (seen.has(n)) {
      pairs.push({ a: seen.get(n), b: sents[i], score: 1 });
      continue;
    }
    seen.set(n, sents[i]);
  }

  // Near-duplicates: embedding similarity OR lexical Jaccard overlap catches
  // reworded repeats the exact match above misses.
  const out = await pipe(sents, { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  for (let i = 0; i < sents.length; i++) {
    for (let j = i + 1; j < sents.length; j++) {
      if (norm(sents[i]) === norm(sents[j])) continue; // already an exact pair
      const s = cosine(vecs[i], vecs[j]);
      const a = toks[i], b = toks[j];
      let inter = 0;
      for (const w of a) if (b.has(w)) inter++;
      const jac = a.size && b.size ? inter / (a.size + b.size - inter) : 0;
      if (s >= 0.7 || jac >= 0.6) {
        pairs.push({ a: sents[i], b: sents[j], score: Number(Math.max(s, jac).toFixed(4)) });
      }
    }
  }

  if (!pairs.length) throw new Error('No duplicate or near-duplicate sentences found.');
  return { pairs: pairs.sort((x, y) => y.score - x.score).slice(0, 10) };
}

// Keyphrase extraction: most central short noun-ish phrases by embedding.
async function runKeyphrases(pipe, inputs) {
  const text = clamp(inputs.text, 'keyphrases');
  if (!text) throw new Error('No text to analyze.');
  const candidates = [...new Set((text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g) || []))].slice(0, 60);
  if (!candidates.length) throw new Error('No keyphrase candidates found.');
  const out = await pipe(candidates, { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  const c = centroid(vecs);
  const ranked = candidates
    .map((term, i) => ({ term, score: cosine(c, vecs[i]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  return { terms: ranked };
}

// FAQ detection: sentences that look like answers to common questions.
async function runFaq(pipe, inputs) {
  const text = clamp(inputs.text, 'faq');
  if (!text) throw new Error('No text to scan.');
  const sents = sentences(text);
  const templates = [
    'this is a frequently asked question',
    'the answer to a common question is',
    'customers often ask about this',
    'here is how it works step by step',
  ];
  const batch = [...templates, ...sents];
  const out = await pipe(batch, { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  const tVecs = vecs.slice(0, templates.length);
  const results = sents
    .map((s, i) => ({ text: s, score: Math.max(...tVecs.map((t) => cosine(t, vecs[templates.length + i]))) }))
    .filter((r) => r.score > 0.18)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  if (!results.length) throw new Error('No FAQ-like passages detected.');
  return { results };
}

// Claim extraction: sentences that assert a factual claim (centroid + template).
async function runClaims(pipe, inputs) {
  const text = clamp(inputs.text, 'claims');
  if (!text) throw new Error('No text to scan.');
  const sents = sentences(text);
  const templates = [
    'this is a factual claim',
    'the study found that',
    'according to the data',
    'it is a verifiable statement',
  ];
  const batch = [...templates, ...sents];
  const out = await pipe(batch, { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  const tVecs = vecs.slice(0, templates.length);
  const results = sents
    .map((s, i) => ({ text: s, score: Math.max(...tVecs.map((t) => cosine(t, vecs[templates.length + i]))) }))
    .filter((r) => r.score > 0.18)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  if (!results.length) throw new Error('No clear claims detected.');
  return { results };
}

// Quote extraction: pull quoted spans (double, curly, or single), then rank by
// embedding centrality so the most representative quotations surface first.
async function runQuotes(pipe, inputs) {
  const text = clamp(inputs.text, 'quotes');
  if (!text) throw new Error('No text to scan.');
  const re = /["“]([^"”]{6,200})["”]|'([^']{6,200})'/g;
  const quotes = [];
  let m;
  while ((m = re.exec(text)) && quotes.length < 40) {
    quotes.push((m[1] || m[2]).trim());
  }
  if (!quotes.length) throw new Error('No quoted text found on this page.');
  const out = await pipe(quotes, { pooling: 'mean', normalize: true });
  const vecs = tensorToVectors(out);
  const c = centroid(vecs);
  const ranked = quotes
    .map((q, i) => ({ text: q, score: cosine(c, vecs[i]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  return { results: ranked };
}

// Acronym detection: NER ORG/PER/LOC plus bracketed definitions.
async function runAcronyms(pipe, inputs) {
  const text = clamp(inputs.text, 'acronyms');
  if (!text) throw new Error('No text to analyze.');
  const out = await pipe(text, { aggregation_strategy: 'simple' });
  const entities = (Array.isArray(out) ? out : []).map((e) => ({
    entity: (e.entity_group || e.entity || '').split('-').pop(),
    word: (e.word || '').replace(/^##/, ''),
    score: typeof e.score === 'number' ? e.score : 0,
  }));
  const re = /\b([A-Z]{2,6})\b\s*(?:\([^)]*\))?\s*[-–—:]?\s*([A-Za-z][^.]{3,80})/g;
  const defs = [];
  let m;
  while ((m = re.exec(text)) && defs.length < 30) defs.push({ acronym: m[1], meaning: m[2].trim() });
  return { entities, definitions: defs.slice(0, 15) };
}

// Number / statistic extraction via regex, ranked by magnitude.
async function runNumbers(pipe, inputs) {
  const text = clamp(inputs.text, 'numbers');
  if (!text) throw new Error('No text to scan.');
  const re = /\b\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?%?|\b\d+(?:\.\d+)?\s?(?:million|billion|thousand|%|kg|km|m|cm|USD|EUR)\b/gi;
  const found = [...new Set((text.match(re) || []).map((s) => s.trim()))];
  if (!found.length) throw new Error('No numbers or statistics found.');
  return { numbers: found.slice(0, 30) };
}

// Date extraction via regex.
async function runDates(pipe, inputs) {
  const text = clamp(inputs.text, 'dates');
  if (!text) throw new Error('No text to scan.');
  const re = /\b(?:\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})\b/gi;
  const found = [...new Set((text.match(re) || []).map((s) => s.trim()))];
  if (!found.length) throw new Error('No dates found on this page.');
  return { dates: found.slice(0, 30) };
}

// Person-only NER. The bert-base-NER pipeline emits BIO tags (B-PER / I-PER)
// under `entity`, so match on the suffix after the dash rather than a bare
// group prefix that never appears.
async function runPersons(pipe, inputs) {
  const text = clamp(inputs.text, 'persons');
  if (!text) throw new Error('No text to analyze.');
  const out = await pipe(text, { aggregation_strategy: 'simple' });
  const persons = (Array.isArray(out) ? out : [])
    .filter((e) => (e.entity_group || e.entity || '').split('-').pop() === 'PER')
    .map((e) => (e.word || '').replace(/^##/, ''));
  const unique = [...new Set(persons)];
  if (!unique.length) throw new Error('No people found in this text.');
  return { persons: unique };
}

// Location-only NER.
async function runPlaces(pipe, inputs) {
  const text = clamp(inputs.text, 'places');
  if (!text) throw new Error('No text to analyze.');
  const out = await pipe(text, { aggregation_strategy: 'simple' });
  const places = (Array.isArray(out) ? out : [])
    .filter((e) => (e.entity_group || e.entity || '').split('-').pop() === 'LOC')
    .map((e) => (e.word || '').replace(/^##/, ''));
  const unique = [...new Set(places)];
  if (!unique.length) throw new Error('No places found in this text.');
  return { places: unique };
}

// Organization-only NER. Consecutive ORG tokens (including ## subwords) are
// merged into a single organization name so "Acme" + "##c" + "##me" +
// "Corporation" becomes "Acme Corporation".
async function runOrgs(pipe, inputs) {
  const text = clamp(inputs.text, 'orgs');
  if (!text) throw new Error('No text to analyze.');
  const out = await pipe(text, { aggregation_strategy: 'simple' });
  const names = [];
  let cur = '';
  for (const e of Array.isArray(out) ? out : []) {
    if ((e.entity_group || e.entity || '').split('-').pop() !== 'ORG') {
      if (cur) { names.push(cur.trim()); cur = ''; }
      continue;
    }
    const w = (e.word || '').replace(/^##/, '');
    cur += (e.word || '').startsWith('##') ? w : (cur ? ' ' : '') + w;
  }
  if (cur) names.push(cur.trim());
  const dedup = [...new Set(names.filter(Boolean))];
  if (!dedup.length) throw new Error('No organizations found in this text.');
  return { orgs: dedup };
}

async function noop() {}

const HANDLERS = {
  summarization: runSummarize,
  'question-answering': runAsk,
  'feature-extraction': runEmbed,
  'search': runSearch,
  'text-classification': runClassify,
  // --- New tasks ---
  'token-classification': runNer,
  'zero-shot-classification': runZeroShot,
  'sentiment': runSentiment,
  'toxicity': runToxicity,
  'reading-time': runReadingTime,
  'keywords': runKeywords,
  'cluster': runCluster,
  'dedupe': runDedupe,
  'related': runRelated,
  'topic': runTopic,
  'intent': runIntent,
  'formality': runFormality,
  'language': runLanguage,
  'factuality': runFactuality,
  'action-items': runActionItems,
  'questions': runQuestions,
  'glossary': runGlossary,
  'outline': runOutline,
  'contradiction': runContradiction,
  'highlight': runHighlight,
  // --- Batch 2 ---
  'bias': runBias,
  'emotion': runEmotion,
  'sarcasm': runSarcasm,
  'urgency': runUrgency,
  'politics': runPolitics,
  'age': runAge,
  'genre': runGenre,
  'coherence': runCoherence,
  'simplicity': runSimplicity,
  'duplicates': runDuplicates,
  'keyphrases': runKeyphrases,
  'faq': runFaq,
  'claims': runClaims,
  'quotes': runQuotes,
  'acronyms': runAcronyms,
  'numbers': runNumbers,
  'dates': runDates,
  'persons': runPersons,
  'places': runPlaces,
  'orgs': runOrgs,
};

module.exports = { HANDLERS, noop };
