// IPC handlers (main process). Wires the renderer's bridge calls to the
// BrowserView manager, AI engine, and persisted state. Every handler is
// defensive: it validates inputs and never lets an engine error bubble up.

const { ipcMain, BrowserWindow, shell, session, app } = require('electron');
const os = require('node:os');
const state = require('./state.js');
const views = require('./views.js');
const menu = require('./menu.js');
const aiEngine = require('../ai/engine-host.js');
const { normalizeEngineError } = require('../ai/engine/errors.js');

function registerIpc() {
   // Increase max listeners for IPC to prevent warnings
   ipcMain.setMaxListeners(100);
  // --- App info / shell -----------------------------------------------------
  ipcMain.handle('get-app-info', () => ({
    name: 'Arcanode AI Browser',
    version: app.getVersion(),
    platform: process.platform,
    arch: os.arch(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    modelCacheDir: state.modelCacheDir(),
  }));

  ipcMain.handle('open-external', async (_event, url) => {
    // Only ever hand real web URLs to the OS; never file:// or custom schemes.
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('load-settings', () => state.readJson(state.settingsFile(), {}));

  ipcMain.handle('save-settings', (_event, settings) => {
    if (!settings || typeof settings !== 'object') return false;
    return state.writeJsonSafe(state.settingsFile(), settings);
  });

  ipcMain.handle('get-cache-stats', async () => {
    const dir = state.modelCacheDir();
    const onDisk = await menu.directorySize(dir);
    let cacheStorage = 0;
    try {
      cacheStorage = await session.defaultSession.getCacheSize();
    } catch {
      /* not fatal */
    }
    return { dir, ...onDisk, cacheStorage };
  });

  ipcMain.handle('clear-model-cache', () => menu.clearModelCache());

  // --- BrowserView (tab) IPC ------------------------------------------------
  ipcMain.handle('view-create', async (_event, { tabId, url }) => {
    if (views.getView(tabId)) return { ok: true };
    views.createView(require('./window.js').getMainWindow(), tabId, url);
    return { ok: true };
  });

  ipcMain.handle('view-destroy', (_event, { tabId }) => {
    views.destroyView(tabId);
    return { ok: true };
  });

  ipcMain.handle('view-set-active', (_event, { tabId }) => {
    views.setActiveView(tabId);
    return { ok: true };
  });

  ipcMain.handle('view-set-bounds', (_event, rect) => {
    views.setPaneBounds(rect);
    return { ok: true };
  });

  ipcMain.handle('view-navigate', async (_event, { tabId, url, options }) => {
    console.log(`[ipc] view-navigate: tabId=${tabId}, url=${url}, options=${JSON.stringify(options)}`);
    const entry = views.getView(tabId);
    if (!entry) return { ok: false };
    const hadError = !!entry.state.error;
    if (hadError) entry.state.userRequestedRetry = true; // user re-typed a URL on a failed page
    const bypassCache = hadError || (options && options.bypassCache);
    entry.state.url = url;
    entry.state.error = null;
    entry.state.loading = true;
    entry.hidden = false;
    if (tabId === views.getActiveTabId()) views.showView(entry);
    views.emitViewState(require('./window.js').getMainWindow(), tabId);
    // Bypass the HTTP cache when navigating from an error state or
    // when explicitly requested, so we don't get a stale offline page.
    const wc = entry.view.webContents;
    if (bypassCache) {
      try {
        await wc.session.clearCache();
      } catch {
        /* non-fatal */
      }
      views.safeLoadURL(wc, url, { extraHeaders: { 'Cache-Control': 'no-store' } });
    } else {
      views.safeLoadURL(wc, url);
    }
    return { ok: true };
  });

  ipcMain.handle('view-back', (_event, { tabId }) => {
    const entry = views.getView(tabId);
    if (entry && views.canGoBack(entry.view.webContents)) {
      entry.view.webContents.navigationHistory.goBack();
    }
    return { ok: true };
  });

  ipcMain.handle('view-forward', (_event, { tabId }) => {
    const entry = views.getView(tabId);
    if (entry && views.canGoForward(entry.view.webContents)) {
      entry.view.webContents.navigationHistory.goForward();
    }
    return { ok: true };
  });

  // Reload / retry a tab. When the page is in an error state (e.g. offline),
  // `webContents.reload()` just re-loads the error page, so instead force a
  // fresh navigation via loadURL — bypassing the HTTP cache — to re-attempt the
  // request. Clear the error and un-hide the view so the overlay disappears.
  // Shared by view-reload and view-clear-error.
    async function retryView(tabId, options) {
    const entry = views.getView(tabId);
    if (!entry) return { ok: false };
    // Default to bypassing the HTTP cache (so a stale offline page is never
    // replayed), but honor an explicit `bypassCache: false` instead of forcing
    // true unconditionally (which previously made the reload() branch dead).
    const bypassCache = options && options.bypassCache === false ? false : true;
    console.log(`[ipc] view-reload: tabId=${tabId}, options=${JSON.stringify(options)}`);
    entry.state.error = null;
    entry.state.loading = true;
    entry.hidden = false;
    entry.state.retrying = true;
    entry.state.userRequestedRetry = true; // this is an explicit user retry
    entry.state.retryCount = 0;
    if (tabId === views.getActiveTabId()) views.showView(entry);
    views.emitViewState(require('./window.js').getMainWindow(), tabId);
    if (bypassCache) {
      try { await entry.view.webContents.session.clearCache(); } catch { /* non-fatal */ }
      views.safeLoadURL(entry.view.webContents, entry.state.url, { extraHeaders: { 'Cache-Control': 'no-store' } });
    } else {
      entry.view.webContents.reload();
    }
    return { ok: true };
  }

  ipcMain.handle('view-reload', (_event, { tabId, options }) => retryView(tabId, options));

  ipcMain.handle('view-stop', (_event, { tabId }) => {
    const entry = views.getView(tabId);
    if (entry) entry.view.webContents.stop();
    return { ok: true };
  });

  // Read the current text selection from a tab's page and pass it straight to
  // the AI as context.
  ipcMain.handle('view-get-selection', async (_event, { tabId }) => {
    const entry = views.getView(tabId);
    if (!entry) return '';
    const wc = entry.view.webContents;
    if (!wc || wc.isDestroyed()) return '';
    try {
      const sel = await wc.executeJavaScript('(document.getSelection ? document.getSelection().toString() : "")');
      return (sel || '').trim().slice(0, 200000);
    } catch (err) {
      console.warn('[ipc] selection read failed:', err.message);
      return '';
    }
  });

  // Extract the readable text of a tab's page to pass straight to the AI as
  // context.
  ipcMain.handle('view-get-text', async (_event, { tabId, limit = 200000 }) => {
    const entry = views.getView(tabId);
    if (!entry) return '';
    return pageText(entry, limit);
  });

  // Read the page text and pass it straight to the AI as context.
  async function pageText(entry, limit) {
    const wc = entry.view.webContents;
    if (!wc || wc.isDestroyed()) return '';
    try {
      const text = await wc.executeJavaScript(
        'document.body ? document.body.innerText : document.documentElement.innerText'
      );
      return (text || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, limit);
    } catch (err) {
      console.warn('[ipc] page innerText read failed:', err.message);
      return '';
    }
  }

  // --- Local AI engine IPC --------------------------------------------------
  // Forward engine progress to the renderer that initiated the request.
  aiEngine.setProgressSink((id, data) => {
    // `id` is the namespaced request id ("<windowId>:<requestId>"). Guard against
    // malformed/empty payloads: an invalid id must never reach fromId (calling
    // it with 0/NaN throws "conversion failure"). Skip such events silently.
    const key = String(id == null ? '' : id).trim();
    const windowId = Number(key.split(':')[0]);
    if (!key || !Number.isInteger(windowId) || windowId <= 0) return;
    const win = BrowserWindow.fromId(windowId);
    if (win && !win.isDestroyed()) win.webContents.send('ai-progress', { id: key, ...data });
  });

  ipcMain.handle('ai-init', async () => {
    try {
      await aiEngine.init(state.modelCacheDir());
      return { ok: true, cacheDir: state.modelCacheDir() };
    } catch (err) {
      return { ok: false, error: normalizeEngineError(err) };
    }
  });

  ipcMain.handle('ai-run', async (event, { task, inputs, options, model, requestId }) => {
    const id = `${event.sender.id}:${requestId || 'req'}`;
    try {
      return await aiEngine.run(task, inputs, options, model, id);
    } catch (err) {
      // Return a normalised, serialisable error object instead of throwing, so
      // the IPC never surfaces as an unhandled rejection in the main process.
      return { error: normalizeEngineError(err) };
    }
  });

  ipcMain.handle('ai-cancel', (_event, id) => {
    aiEngine.cancel(id);
    return true;
  });
}

module.exports = { registerIpc, normalizeEngineError };
