// Thin wrapper around the preload-exposed `window.api`. If the preload script
// failed to load, fall back to inert stubs so the browser half still works and
// the failure surfaces as a console warning instead of an uncaught TypeError.

const missing = () => {
  console.warn('[api-bridge] preload bridge unavailable; running in degraded mode.');
  return Promise.resolve(undefined);
};

const fallback = {
  getAppInfo: missing,
  openExternal: missing,
  loadSettings: () => Promise.resolve({}),
  saveSettings: () => Promise.resolve(false),
  clearModelCache: missing,
  getCacheStats: () => Promise.resolve(null),
  onMenuCommand: () => () => {},
};

export const api = typeof window !== 'undefined' && window.api ? window.api : fallback;

export const hasBridge = typeof window !== 'undefined' && Boolean(window.api);
