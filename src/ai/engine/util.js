// Shared helpers for the AI engine: text preparation, embedding extraction,
// vector similarity, and result normalisation.
//
// These are pure functions with no model state, so they can be reused by every
// task handler without duplication.

const { INPUT_LIMIT } = require('./config.js');

/** Trim + collapse whitespace and truncate to a task's character ceiling,
 *  cutting at the last sentence boundary when possible. */
function clamp(text, task) {
  const limit = INPUT_LIMIT[task] || 2000;
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit);
  const lastStop = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('? ')
  );
  return lastStop > limit * 0.6 ? cut.slice(0, lastStop + 1) : cut;
}

/** Split text into sentence-ish chunks no larger than `size` characters. */
function chunk(text, size) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= size) return clean ? [clean] : [];

  const sentences = clean.match(/[^.!?]+[.!?]+|\S+$/g) || [clean];
  const chunks = [];
  let buf = '';

  for (const s of sentences) {
    if ((buf + s).length > size && buf) {
      chunks.push(buf.trim());
      buf = '';
    }
    if (s.length > size) {
      for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size).trim());
      continue;
    }
    buf += s;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

/** Split text into individual sentences (no merging). Used by features that
 *  compare sentences pairwise (duplicates, claims, faq) so each unit stays
 *  independent regardless of overall length. */
function sentences(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  return (clean.match(/[^.!?]+[.!?]+|\S+$/g) || [clean])
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

/** Cosine similarity between two equal-length vectors. */
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/** Convert a Transformers.js tensor (dims + data) into an array of vectors. */
function tensorToVectors(out) {
  const dim = out.dims[1];
  return Array.from({ length: out.dims[0] }, (_, i) =>
    Array.from(out.data.slice(i * dim, (i + 1) * dim))
  );
}

/** Mean vector of a list of equal-length vectors. */
function centroid(vecs) {
  return vecs[0].map((_, j) => vecs.reduce((s, v) => s + v[j], 0) / vecs.length);
}

// Normalize a zero-shot / NLI classifier output into a ranked [{label, score}]
// list. The underlying model returns EITHER an array of {label, score} objects
// OR a single object with parallel `labels` / `scores` arrays — handle both.
function normalizeRanked(out) {
  let pairs;
  if (out && Array.isArray(out.labels) && Array.isArray(out.scores)) {
    pairs = out.labels.map((label, i) => ({ label, score: out.scores[i] }));
  } else if (Array.isArray(out)) {
    pairs = out.map((r) => ({ label: r.label, score: r.score }));
  } else if (out && Array.isArray(out.labels)) {
    pairs = out.labels.map((label, i) => ({ label, score: out.scores?.[i] }));
  } else {
    pairs = [];
  }
  return pairs
    .map((r) => ({ label: r.label, score: typeof r.score === 'number' ? r.score : 0 }))
    .sort((a, b) => b.score - a.score);
}

/** Rank a text-classification model output (array of {label, score}). */
function rankClassification(out) {
  const scores = Array.isArray(out) ? out : [out];
  return scores
    .map((s) => ({ label: s.label, score: typeof s.score === 'number' ? s.score : 0 }))
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  clamp,
  chunk,
  sentences,
  cosine,
  tensorToVectors,
  centroid,
  normalizeRanked,
  rankClassification,
};
