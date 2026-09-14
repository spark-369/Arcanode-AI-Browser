// Application menu (main process). Built once at startup. Items that need to talk
// to the renderer send a `menu` IPC command string; the renderer decides what to
// do, keeping the menu decoupled from window internals.

const { Menu, dialog, shell, app, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const state = require('./state.js');

const send = (mainWindow, channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
};

function buildMenu(mainWindow) {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '&File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => send(mainWindow, 'menu', 'new-tab'),
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => send(mainWindow, 'menu', 'close-tab'),
        },
        { type: 'separator' },
        {
          label: 'Focus Address Bar',
          accelerator: 'CmdOrCtrl+L',
          click: () => send(mainWindow, 'menu', 'focus-address'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        {
          label: 'Reload Page',
          accelerator: 'CmdOrCtrl+R',
          click: () => send(mainWindow, 'menu', 'reload'),
        },
        {
          label: 'Toggle AI Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => send(mainWindow, 'menu', 'toggle-sidebar'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: '&AI',
      submenu: [
        { label: 'Summarize Page', accelerator: 'CmdOrCtrl+Shift+S', click: () => send(mainWindow, 'menu', 'summarize') },
        { label: 'Ask About Page', accelerator: 'CmdOrCtrl+Shift+A', click: () => send(mainWindow, 'menu', 'ask') },
        { label: 'Search Page', accelerator: 'CmdOrCtrl+Shift+C', click: () => send(mainWindow, 'menu', 'search') },
        { label: 'Analyze Tone', accelerator: 'CmdOrCtrl+Shift+E', click: () => send(mainWindow, 'menu', 'tone') },
        { type: 'separator' },
        {
          label: 'Clear Model Cache…',
          click: async () => {
            const { response } = await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              buttons: ['Cancel', 'Clear Cache'],
              defaultId: 1,
              cancelId: 0,
              title: 'Clear Model Cache',
              message: 'Delete all downloaded AI models?',
              detail:
                'They will be re-downloaded the next time you use an AI feature. This requires an internet connection.',
            });
            if (response === 1) {
              await clearModelCache();
              send(mainWindow, 'menu', 'cache-cleared');
            }
          },
        },
      ],
    },
    { role: 'windowMenu' },
    {
      label: '&Help',
      submenu: [
        {
          label: 'About Aurora Browser',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Aurora Browser',
              message: `Aurora Browser ${app.getVersion()}`,
              detail: [
                'A privacy-first browser that runs lightweight AI models entirely on your machine.',
                '',
                `Electron ${process.versions.electron}`,
                `Chromium ${process.versions.chrome}`,
                `Node ${process.versions.node}`,
                `Platform ${process.platform}-${os.arch()}`,
                '',
                'No telemetry. No inference in the cloud. Model weights are downloaded once and cached locally.',
              ].join('\n'),
            });
          },
        },
        {
          label: 'Open Model Cache Folder',
          click: () => {
            const dir = state.modelCacheDir();
            fs.mkdirSync(dir, { recursive: true });
            shell.openPath(dir);
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Model cache helpers
// ---------------------------------------------------------------------------

async function directorySize(dir) {
  let total = 0;
  let files = 0;
  async function walk(d) {
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        try {
          const st = await fs.promises.stat(full);
          total += st.size;
          files++;
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  await walk(dir);
  return { bytes: total, files };
}

async function clearModelCache() {
  // Weights live in the Cache Storage of the renderer session (Transformers.js
  // `useBrowserCache`) and, for pre-seeded models, on disk.
  try {
    await session.defaultSession.clearStorageData({ storages: ['cachestorage'] });
  } catch (err) {
    console.error('Failed to clear cache storage:', err.message);
  }
  try {
    const dir = state.modelCacheDir();
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    console.error('Failed to clear model directory:', err.message);
  }
  return true;
}

module.exports = { buildMenu, clearModelCache, directorySize };
