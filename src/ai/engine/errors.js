// Shared normalisation of engine errors into user-facing messages. Used by both
// the worker (which catches model/download failures) and the IPC layer (which
// catches anything that escapes the worker) so the wording stays consistent.

const RULES = [
  {
    re: /Failed to fetch|fetch failed|NetworkError|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_|getaddrinfo/i,
    msg: 'Could not download the model. Connect to the internet once to cache it, then it works offline.',
  },
  { re: /Unauthorized|401|403/, msg: 'The model repository refused the request. It may be gated or renamed.' },
  {
    re: /out of memory|RuntimeError|memory access out of bounds|Allocation failed/i,
    msg: 'The model ran out of memory. Try a shorter page or restart the app.',
  },
];

function normalizeEngineError(err) {
  const raw = err?.message || String(err);
  for (const { re, msg } of RULES) {
    if (re.test(raw)) return msg;
  }
  return raw;
}

module.exports = { normalizeEngineError };
