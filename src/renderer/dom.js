// Small DOM + URL helpers shared across the renderer modules.

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/** Turns whatever the user typed into a navigable URL or a search query. */
export function normalizeUrl(input) {
  const v = (input || '').trim();
  if (!v) return HOME_URL;

  if (/^(https?|file|about):/i.test(v)) return v;
  if (/^localhost(:\d+)?(\/|$)/i.test(v)) return `http://${v}`;

  // Looks like a bare domain (has a dot, no spaces, valid-ish TLD).
  if (/^[^\s]+\.[a-z]{2,}([/:?#].*)?$/i.test(v) && !v.includes(' ')) {
    return `https://${v}`;
  }

  return `https://duckduckgo.com/?q=${encodeURIComponent(v)}`;
}

/** Compact URL for display in the omnibox (drops protocol + trailing slash). */
export function prettyUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return url;
    let s = u.host + u.pathname + u.search + u.hash;
    if (s.endsWith('/') && !u.search && !u.hash) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

export const HOME_URL = 'https://duckduckgo.com';
