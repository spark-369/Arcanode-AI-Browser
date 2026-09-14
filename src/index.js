// Arcanode AI Browser — main process entry point. Wires together the modules in
// ./main (state, window, views, menu, ipc) and handles process-level concerns
// (single-instance lock, Chromium flags, engine teardown, crash reporting).

const electron = require('electron');
const { app, BrowserWindow, protocol } = electron;
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// App shell scheme
// ---------------------------------------------------------------------------
// The renderer runs ES modules (<script type="module">), which browsers refuse
// to load over file:// (module fetches are subject to CORS and file:// is an
// opaque cross-origin source — the renderer silently never runs). Serving the
// shell from the custom "app://" scheme below gives module scripts, dynamic
// import(), and fetch() a real same-origin context. Declared as standard +
// secure so it's a trustworthy origin and the app's CSP 'self' still applies.

const SCHEME = 'app';
const SRC_DIR = path.join(__dirname);

// Must be declared BEFORE `app.whenReady()` so Chromium treats app:// as a
// standard, secure origin (otherwise CSP 'self' matches nothing and the shell's
// own stylesheet + renderer.js are refused). standard -> real host/path URLs for
// relative imports; secure -> trustworthy origin; supportFetchAPI + corsEnabled
// -> ES module graphs and fetch() work; stream -> streamed/ranged responses.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// Registers the app:// handler. Must be registered per-session: a BrowserView
// with a custom partition (e.g. "persist:ailocal") gets its OWN session, and a
// handler on the default session alone makes app:// loads in those views hang.
function registerShellProtocolOn(proto) {
  proto.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      // Resolve the path against src, guarding against traversal; normalise a
      // trailing slash (Electron may append one to the root path).
      let rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      rel = rel.replace(/\/+$/, '') || 'index.html';
      // App-internal routes are prefixed "app/"; strip it so the checks match.
      if (rel === 'app' || rel.startsWith('app/')) {
        rel = rel.slice('app/'.length) || 'index.html';
      }

      const target = path.normalize(path.join(SRC_DIR, rel));
      if (!target.startsWith(SRC_DIR)) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        return new Response('Not found', { status: 404 });
      }
      const ext = path.extname(target).toLowerCase();
      const types = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.woff2': 'font/woff2',
      };
      const headers = { 'Content-Type': types[ext] || 'application/octet-stream' };
      // Body must be a string, not a Buffer: protocol.handle may drop Buffers.
      const body = fs.readFileSync(target, 'utf-8');
      return new Response(body, { status: 200, headers });
    } catch (err) {
      return new Response('Error: ' + err.message, { status: 500 });
    }
  });
}

// Register the shell protocol on the default session AND on the persist:ailocal
// partition session used by every BrowserView tab. Without the partition
// registration, app:// loads in those views hang indefinitely.
function configureShellProtocol() {
  registerShellProtocolOn(protocol);
  try {
    const { session } = require('electron');
    registerShellProtocolOn(session.fromPartition('persist:ailocal').protocol);
  } catch (err) {
    console.warn('[protocol] partition registration failed:', err.message);
  }
}

// Local AI engine — runs Transformers.js in a dedicated child process (native
// ONNX) so a model crash or OOM cannot take down the browser window.
const aiEngine = require('./ai/engine-host.js');

// Squirrel (Windows installer) launches with special flags on install/update;
// bail out in those cases.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Chromium runtime flags keep <webview> guests stable in containerised Linux
// (small /dev/shm, no GPU, no setuid sandbox, PID namespaces), where they would
// otherwise crash as "This page could not be loaded" for every URL.
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('disable-gpu');
// The app already runs with nodeIntegration disabled + context isolation, so
// disabling the Chromium sandbox/zygote here does not weaken the security model.
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'site-per-process');
// The zygote's sandboxed helper fails to rendezvous across PID namespaces
// ("Creating shared memory in /tmp/... No such process (3)", ERR_FAILED on every
// navigation). Spawning renderers directly sidesteps the broken handshake.
app.commandLine.appendSwitch('no-zygote');
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');

// Chromium's default /tmp rendezvous fails in restricted environments, killing
// every webview guest; point it at a writable dir under the user's cache.
const chromiumTmp = path.join(app.getPath('cache'), 'ai-local-browser-tmp');
try {
  fs.mkdirSync(chromiumTmp, { recursive: true });
  app.setPath('temp', chromiumTmp);
  process.env.TMPDIR = chromiumTmp;
  process.env.TEMP = chromiumTmp;
  process.env.TMP = chromiumTmp;
} catch (err) {
  console.error('Failed to set Chromium temp dir:', err.message);
}

// Only one instance may own the model cache and settings file at a time.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const state = require('./main/state.js');
const { createWindow, getMainWindow } = require('./main/window.js');
const { buildMenu } = require('./main/menu.js');
const { registerIpc } = require('./main/ipc.js');

// ---------------------------------------------------------------------------
// Session hardening
// ---------------------------------------------------------------------------

function hardenSessions() {
  const { session } = require('electron');
  // Deny every permission request (camera/mic/geolocation) by default.
  const deny = (_wc, _permission, callback) => callback(false);

  session.defaultSession.setPermissionRequestHandler(deny);
  session.fromPartition('persist:ailocal').setPermissionRequestHandler(deny);
  session.fromPartition('persist:ailocal').setPermissionCheckHandler(() => false);

  // NOTE: deliberately no global request blocker — pages must be free to load
  // any site. The privacy guarantee is "AI inference never leaves the device",
  // not "block all web traffic"; the shell itself is locked down by its CSP.
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

app.on('second-instance', () => {
  const win = getMainWindow();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  // A second instance that lost the lock is already quitting; do not build UI.
  if (!gotLock) return;

  // Serve the app shell over the privileged app:// scheme so the renderer's
  // ES modules load (file:// blocks module CORS).
  configureShellProtocol();

  fs.mkdirSync(state.modelCacheDir(), { recursive: true });
  hardenSessions();
  // Point the engine at the on-disk model cache up front.
  aiEngine.init(state.modelCacheDir());
  registerIpc();
  buildMenu(getMainWindow());
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Tear down the engine worker process when the app exits so it does not linger.
app.on('before-quit', () => {
   try {
     aiEngine.shutdown();
   } catch {
     /* ignore */
   }
   // Clean up main window listeners to prevent warnings
   const win = getMainWindow();
   if (win && !win.isDestroyed()) {
     win.removeAllListeners();
     win.webContents.removeAllListeners();
   }
 });

// Surface unexpected failures instead of dying silently.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in main process:', err);
  const win = getMainWindow();
  if (app.isReady() && win && !win.isDestroyed()) {
    const { dialog } = require('electron');
    dialog.showErrorBox('Unexpected Error', err.stack || err.message);
  }
});

// Never let a rejected promise in the main process die silently.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection in main process:', reason);
  const win = getMainWindow();
  if (app.isReady() && win && !win.isDestroyed()) {
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'Unexpected Error',
      (reason && (reason.stack || reason.message)) || String(reason),
    );
  }
});
