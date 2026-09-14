const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets no Node/Electron access; every capability is listed
// explicitly, and each listener returns its own unsubscribe function.

// Each tab's BrowserView attaches ~11 listeners to its webContents (default
// EventEmitter max is 10), so raise the limit to avoid MaxListeners warnings.
ipcRenderer.setMaxListeners(50);

/** Wraps `ipcRenderer.on` so callbacks never receive the raw IpcRendererEvent
 *  (which would expose `sender` and let the renderer escalate). */
function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  // --- Info ---------------------------------------------------------------
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  // --- Shell --------------------------------------------------------------
  openExternal: (url) => ipcRenderer.invoke('open-external', String(url ?? '')),

  // --- Settings -----------------------------------------------------------
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // --- Model cache --------------------------------------------------------
  getCacheStats: () => ipcRenderer.invoke('get-cache-stats'),
  clearModelCache: () => ipcRenderer.invoke('clear-model-cache'),

  // --- Local AI engine ----------------------------------------------------
  /** Boots the engine in the main process (sets the model cache dir). */
  aiInit: () => ipcRenderer.invoke('ai-init'),
  /** Runs a task in the main process. Returns the result object. */
  aiRun: (payload) => ipcRenderer.invoke('ai-run', payload),
  /** Best-effort cancellation of an in-flight request by id. */
  aiCancel: (id) => ipcRenderer.invoke('ai-cancel', id),

  // --- Events pushed from the main process --------------------------------
  /** Menu accelerators and menu-item clicks. */
  onMenuCommand: (callback) => subscribe('menu', callback),
  /** A guest page tried to open a new window (target=_blank). */
  onOpenUrl: (callback) => subscribe('open-url', callback),
  /** Live progress from the local AI engine (download / work / done). */
  onAiProgress: (callback) => subscribe('ai-progress', callback),

  // --- BrowserView (tab) management --------------------------------------
  viewCreate: (tabId, url) => ipcRenderer.invoke('view-create', { tabId, url }),
  /** Destroy a tab's BrowserView. */
  viewDestroy: (tabId) => ipcRenderer.invoke('view-destroy', { tabId }),
  /** Attach a tab's BrowserView to the window. */
  viewSetActive: (tabId) => ipcRenderer.invoke('view-set-active', { tabId }),
  /** Set the browser pane rectangle within the window. */
  viewSetBounds: (rect) => ipcRenderer.invoke('view-set-bounds', rect),
  viewNavigate: (tabId, url, options) => ipcRenderer.invoke('view-navigate', { tabId, url, options }),
  /** History back / forward / reload / stop. */
  viewBack: (tabId) => ipcRenderer.invoke('view-back', { tabId }),
  viewForward: (tabId) => ipcRenderer.invoke('view-forward', { tabId }),
  viewReload: (tabId, options) => ipcRenderer.invoke('view-reload', { tabId, options }),
  viewStop: (tabId) => ipcRenderer.invoke('view-stop', { tabId }),
  viewGetText: (tabId, limit) => ipcRenderer.invoke('view-get-text', { tabId, limit }),
  /** Extract the user's current text selection from a tab's page. */
  viewGetSelection: (tabId, selection) => ipcRenderer.invoke('view-get-selection', { tabId, selection }),
  /** Tab state updates pushed from the main process. */
  onViewState: (callback) => subscribe('view-state', callback),
});
