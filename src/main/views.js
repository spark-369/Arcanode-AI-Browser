// BrowserView manager (main process). Each tab is backed by a persistent
// BrowserView created here (not a <webview> in the renderer). Only the active
// view is attached to the window at a time; the rest keep their state alive
// off-screen. The renderer drives everything via IPC and gets state via events.

const { BrowserWindow, BrowserView } = require('electron');

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** Chromium net errors that are not real failures and must not surface as an
 *  error page. */
const IGNORED_ERRORS = new Set([
  -3, // ABORTED — superseded by a newer navigation (redirects, client-side routing)
  -27, // BLOCKED_BY_RESPONSE (download handoff)
  -6,  // ERR_ABORTED — aborted during retry/reload
  -1,  // ERR_FAILED — generic, may be transient when network recovers
]);

/** Errors that are almost always transient connectivity issues: Chromium emits
 *  these when the OS network stack has "not yet noticed" it's back up even
 *  though we can already reach hosts (e.g. the favicon fetch succeeds but the
 *  BrowserView loadURL still fails). Retry these a few times automatically
 *  before surfacing a hard error page, so the user doesn't end up staring at
 *  the offline overlay while the main page load catches up. */
const TRANSIENT_ERRORS = new Set([-105, -106]);

const views = new Map(); // tabId -> { view, state }
let activeTabId = null;
// Bounds of the browser pane within the window (set by the renderer).
let paneBounds = { x: 0, y: 0, width: 0, height: 0 };

// `webContents.canGoBack/Forward` are deprecated; prefer `navigationHistory`.
function canGoBack(wc) {
  return wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack();
}
function canGoForward(wc) {
  return wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward();
}

// `loadURL()` rejects on any aborted/failed navigation (routine — redirects,
// client-side routing, offline loads). Unhandled these surface as rejections in
// the main process; the real failure is reported via `did-fail-load`, so
// swallow the rejection here and let that handler own the user-facing error.
function safeLoadURL(wc, url, opts) {
  if (!wc || wc.isDestroyed()) return Promise.resolve();
  try {
    const p = wc.loadURL(url, opts);
    return p && typeof p.catch === 'function' ? p.catch(() => {}) : Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}

// Favicons are fetched here (main) and inlined as data: URIs because the shell's
// CSP forbids remote images (`img-src 'self' data: blob:`), so raw https URLs
// would be refused and every tab would show a blank dot. Inlining also keeps the
// shell from directly requesting sites the user merely browses.
const FAVICON_MAX_BYTES = 256 * 1024;
const faviconCache = new Map(); // remote url -> data: URI ('' when unusable)
const FAVICON_CACHE_MAX = 256;

async function faviconDataUri(url) {
  if (!url || !/^https?:/i.test(url)) return '';
  if (faviconCache.has(url)) return faviconCache.get(url);

    console.log(`[views] faviconDataUri: Fetching ${url}`);
  let dataUri = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let res;
    try {
      res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res && res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      const type = (res.headers.get('content-type') || 'image/x-icon').split(';')[0].trim();
      // Only inline real, reasonably sized raster/vector icons.
      if (buf.length && buf.length <= FAVICON_MAX_BYTES && /^image\//i.test(type)) {
        dataUri = `data:${type};base64,${buf.toString('base64')}`;
      }
    }
  } catch {
    /* offline, blocked, or malformed icon: fall back to the neutral dot */
  }

  // Bound the cache so a long browsing session cannot grow it without limit.
  if (faviconCache.size >= FAVICON_CACHE_MAX) {
    faviconCache.delete(faviconCache.keys().next().value);
  }
  faviconCache.set(url, dataUri);
  return dataUri;
}

function emitViewState(mainWindow, tabId) {
  const entry = views.get(tabId);
  if (!entry || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('view-state', {
    tabId,
    ...entry.state,
  });
}

// Rect for the active view: prefer the renderer-reported pane bounds; fall back
// to the window's content area before the renderer has laid out (so the first
// tab is visible rather than a blank 0x0 pane).
function effectiveBounds() {
  if (paneBounds.width && paneBounds.height) return paneBounds;
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    const [w, h] = win.getContentSize();
    return { x: 0, y: 0, width: w, height: h };
  }
  return paneBounds;
}

function applyBounds(entry) {
  if (!entry) return;
  entry.view.setBounds(effectiveBounds());
}

// Attach a view to the window (only when active + not errored). NOTE: call
// addBrowserView on the actual window (from getFocusedWindow/allWindows), NOT on
// BrowserWindow.fromBrowserView(view) — the latter is null for a never-attached
// view, so it would throw and leave a blank shell.
function showView(entry) {
  if (!entry) return;
  if (entry.hidden) return;
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  try {
    if (BrowserWindow.fromBrowserView(entry.view) !== win) {
      win.addBrowserView(entry.view);
    }
    applyBounds(entry);
  } catch {
    /* already attached */
  }
}

// Detach a view from the window so the renderer DOM (e.g. the error overlay)
// becomes visible behind where the native view was.
function hideView(entry) {
  if (!entry) return;
  const win = BrowserWindow.fromBrowserView(entry.view);
  if (win && !win.isDestroyed()) {
    try {
      win.removeBrowserView(entry.view);
    } catch {
      /* not attached */
    }
  }
}

function createView(mainWindow, tabId, url) {
  const view = new BrowserView({
    webPreferences: {
      partition: 'persist:ailocal',
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      sandbox: false,
    },
  });

  view.webContents.setUserAgent(USER_AGENT);

  // Each tab attaches ~11 event listeners to its webContents. Chromium's
  // default EventEmitter limit is 10, so without this the console floods with
  // MaxListenersExceededWarning on every tab open.
  view.webContents.setMaxListeners(50);

  // Guest pages must not spawn windows or attach further webviews.
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) mainWindow?.webContents.send('open-url', url);
    return { action: 'deny' };
  });
  view.webContents.on('will-attach-webview', (event) => event.preventDefault());

  const state = {
    url: url || '',
    title: 'New tab',
    favicon: '',
    loading: true,
    canGoBack: false,
    canGoForward: false,
    error: null,
    finished: false,
    retrying: false,
    retryCount: 0,
    userRequestedRetry: false,
    // Monotonic "current navigation attempt" counters. `navSeq` bumps on every
    // did-start-loading; `loadedSeq` records the seq of the last COMMITTED
    // (successful) navigation. Comparing the two lets did-fail-load ignore late
    // failure events from a superseded/aborted attempt — the precise fix for
    // the offline→online "stuck offline page" race.
    navSeq: 0,
    loadedSeq: 0,
  };

  const entry = { view, state, hidden: false };

  const syncHistory = () => {
    try {
      state.canGoBack = canGoBack(view.webContents);
      state.canGoForward = canGoForward(view.webContents);
    } catch {
      state.canGoBack = false;
      state.canGoForward = false;
    }
  };

  view.webContents.on('did-start-loading', () => {
    state.loading = true;
    state.finished = false;
    state.error = null;
    state.retrying = true;
    // A new load attempt invalidates any stale failure event still in flight.
    state.navSeq++;
    // A fresh load means we should show the view again (it may have been
    // hidden to reveal the error overlay).
    entry.hidden = false;
    if (tabId === activeTabId) showView(entry);
    emitViewState(mainWindow, tabId);
  });
  view.webContents.on('did-finish-load', () => {
    // Note: also fires for error pages, so it must NOT clear error state (that
    // would hide genuine failures); error is cleared on a navigation commit.
    state.finished = true;
    state.retryCount = 0;
    emitViewState(mainWindow, tabId);
  });
    view.webContents.on('did-stop-loading', () => {
    state.loading = false;
    state.retrying = false;
    // If the tab was hidden (e.g. previously errored) and a navigation is now
    // idle, make sure the BrowserView is attached so the loaded page — not the
    // renderer's error overlay — is what the user sees. did-start-loading
    // normally does this, but that event can race with destroy/setActiveView, so
    // re-assert it here for the active tab.
    entry.hidden = false;
    if (tabId === activeTabId) showView(entry);
    syncHistory();
    emitViewState(mainWindow, tabId);
  });
  view.webContents.on('page-title-updated', (e, title) => {
    state.title = title || state.url;
    emitViewState(mainWindow, tabId);
  });
  view.webContents.on('page-favicon-updated', (e, favicons) => {
    const remote = Array.isArray(favicons) ? favicons[0] || '' : '';
    if (!remote) {
      state.favicon = '';
      emitViewState(mainWindow, tabId);
      return;
    }
    // Resolve asynchronously: emit the state we already have, then emit again
    // once the icon is inlined, so the tab strip never blocks on the fetch.
    faviconDataUri(remote)
      .then((dataUri) => {
        if (!dataUri || !views.has(tabId)) return;
        state.favicon = dataUri;
        emitViewState(mainWindow, tabId);
      })
      .catch((err) => { console.error(`[views] faviconDataUri: Error fetching ${remote}:`, err); });
  });
  const onNavigate = (e, navUrl) => {
    // Only treat real page URLs as the canonical tab URL; Chromium-internal
    // error pages (about:neterror, chrome://net-error/..., data: URLs) must not
    // overwrite the URL the user actually tried to load.
    if (navUrl && /^(https?|ftp|file|data):/i.test(navUrl)) {
      state.url = navUrl;
    }
    // A successful commit means the page is loading fine: clear any prior error
    // and show the view (not the error overlay).
    state.error = null;
    state.finished = true;
    state.loadedSeq = state.navSeq; // mark this attempt as committed successfully
    state.retrying = false;
    state.userRequestedRetry = false; // the user's retry succeeded
    state.retryCount = 0;
    entry.hidden = false;
    if (tabId === activeTabId) showView(entry);
    syncHistory();
    emitViewState(mainWindow, tabId);
  };
  view.webContents.on('did-navigate', onNavigate);
  view.webContents.on('did-navigate-in-page', onNavigate);
    view.webContents.on('did-fail-load', async (e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      const { tabId } = entry.state;
      console.log(`[views] did-fail-load for tab ${tabId}: errorCode=${errorCode}, errorDescription=${errorDescription}, validatedURL=${validatedURL}, isMainFrame=${isMainFrame}`);
    // `isMainFrame` is the 5th callback arg (not an event property).
    if (isMainFrame === false) return;

    // A late/stale failure: ignore if a success already committed for this attempt.
    if (state.loadedSeq === state.navSeq) return;

    // Transient network errors are retried briefly before surfacing an error
    // page. Two classes:
    //  - IGNORED_ERRORS (-3/-27/-6/-1): routine/aborted navigations where
    //    retrying the whole load would be wrong; just swallow and let the next
    //    real navigation decide.
    //  - TRANSIENT_ERRORS (-105 DNS / -106 no-network): these can fire even
    //    when connectivity is returning (the main process favicon fetch may
        //    already succeed while Chromium's session still holds a cached "no
    //    network" / negative-DNS result). Auto-retry a few times so the page
    //    recovers without the user having to click "Try again" repeatedly.
    if (IGNORED_ERRORS.has(errorCode)) {
      console.log(`[views] did-fail-load for tab ${tabId}: IGNORED_ERROR code=${errorCode}`);
      return;
    }

    if (TRANSIENT_ERRORS.has(errorCode)) {
      // (Re)arm the bounded retry whenever one of these transient errors fires,
      // even if did-stop-loading already cleared `retrying`/`retryCount`.
      if (!state.retrying || (state.retryCount || 0) === 0) {
        console.log(`[views] did-fail-load for tab ${tabId}: Initiating transient retry sequence for ${validatedURL}.`);
        state.retrying = true;
        state.userRequestedRetry = true;
        state.retryCount = 0;
      }
      const limit = 6;
      const delay = 1500;
      state.retryCount = (state.retryCount || 0) + 1;
      console.log(`[views] did-fail-load for tab ${tabId}: TRANSIENT_ERROR code=${errorCode}, retryCount=${state.retryCount}/${limit} for ${validatedURL}.`);
      if (state.retryCount >= limit) {
        state.userRequestedRetry = false;
        state.retrying = false;
        state.loading = false;
        console.warn(`[views] did-fail-load for tab ${tabId}: Gave up on transient error ${errorCode} after ${state.retryCount} retries.`);
        emitViewState(mainWindow, tabId);
      } else {
        setTimeout(() => {
          console.log(`[views] did-fail-load for tab ${tabId}: Retrying URL ${entry.state.url} after delay.`);
          if (!views.has(tabId)) return;
          state.retrying = true;
          safeLoadURL(entry.view.webContents, entry.state.url, {
            extraHeaders: { 'Cache-Control': 'no-store' },
          });
        }, delay);
      }
      return;
    }

    // Non-transient failure: stop loading so the toolbar spinner clears.
    // Chromium's own error page (about:neterror) will be visible in the
    // BrowserView; we no longer surface a custom offline overlay.
    state.loading = false;
    state.retrying = false;
    emitViewState(mainWindow, tabId);
  });

  views.set(tabId, entry);
  if (url) {
    safeLoadURL(view.webContents, url);
  }
  return entry;
}

function destroyView(tabId) {
   const entry = views.get(tabId);
   if (!entry) return;
   const win = BrowserWindow.fromBrowserView(entry.view)
     || BrowserWindow.getFocusedWindow()
     || BrowserWindow.getAllWindows()[0];
   if (win && !win.isDestroyed()) {
     try {
       win.removeBrowserView(entry.view);
     } catch {
       /* not attached */
     }
   }
   // Remove all listeners to prevent memory leaks
   entry.view.webContents.removeAllListeners();
   entry.view.webContents.destroy();
   views.delete(tabId);
   if (activeTabId === tabId) activeTabId = null;
}

function setActiveView(tabId) {
   const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
   if (!win || win.isDestroyed()) return;
    const next = views.get(tabId);
    if (!next) return;

   // Detach the previously active view (only one can be shown at a time).
   if (activeTabId && activeTabId !== tabId) {
     const prev = views.get(activeTabId);
     if (prev) hideView(prev);
   }

   activeTabId = tabId;
    // Only show the view if it is not hidden.
    if (next.hidden) {
      hideView(next);
    } else {
      showView(next);
      next.view.webContents.focus();
    }
  }

function setPaneBounds(rect) {
  paneBounds = { ...paneBounds, ...rect };
  const entry = activeTabId ? views.get(activeTabId) : null;
  if (entry) applyBounds(entry);
}

/** Re-apply the current pane bounds to the active view (e.g. after a resize). */
function applyBoundsToActive() {
  const entry = activeTabId ? views.get(activeTabId) : null;
  if (entry) applyBounds(entry);
}

function getView(tabId) {
  return views.get(tabId);
}

module.exports = {
  USER_AGENT,
  IGNORED_ERRORS,
  canGoBack,
  canGoForward,
  safeLoadURL,
  createView,
  destroyView,
  setActiveView,
  setPaneBounds,
  getView,
  showView,
  emitViewState,
  getActiveTabId: () => activeTabId,
  setActiveTabId: (id) => { activeTabId = id; },
  applyBoundsToActive,
};
