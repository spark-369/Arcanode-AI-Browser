// History: per-URL visit log stored in IndexedDB.
//
// Records every page the user navigates to (deduplicated by URL, keeping the
// most recent visit on top), and lets the UI list and delete entries. Runs
// entirely on-device in the renderer — no network, no main-process storage.

const DB_NAME = 'ai-local-browser';
const DB_VERSION = 1;
const STORE = 'history';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'url' });
        store.createIndex('visitedAt', 'visitedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode) {
  return openDb().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

/** Record (or bump) a visit for a URL. */
export async function addHistory(url, { title = '', favicon = '' } = {}) {
  if (!url || url.startsWith('about:') || url.startsWith('file:')) return;
  try {
    const store = await tx('readwrite');
    store.put({ url, title, favicon, visitedAt: Date.now() });
  } catch (err) {
    console.warn('History add failed:', err);
  }
}

/** Return visits newest-first. */
export async function getHistory() {
  try {
    const store = await tx('readonly');
    return await new Promise((resolve, reject) => {
      const out = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          out.push(cur.value);
          cur.continue();
        } else {
          out.sort((a, b) => b.visitedAt - a.visitedAt);
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('History read failed:', err);
    return [];
  }
}

/** Delete a single URL from history. */
export async function deleteHistory(url) {
  try {
    const store = await tx('readwrite');
    store.delete(url);
  } catch (err) {
    console.warn('History delete failed:', err);
  }
}

/** Delete every entry. */
export async function clearHistory() {
  try {
    const store = await tx('readwrite');
    store.clear();
  } catch (err) {
    console.warn('History clear failed:', err);
  }
}
