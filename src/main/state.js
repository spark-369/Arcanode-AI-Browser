// Persisted application state (window bounds + user settings).
// All reads/writes use safe, atomic temp-file helpers so a crash mid-write
// cannot corrupt the file.

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const userDataPath = () => app.getPath('userData');
const settingsFile = () => path.join(userDataPath(), 'settings.json');
const windowStateFile = () => path.join(userDataPath(), 'window-state.json');
const modelCacheDir = () => path.join(userDataPath(), 'models');

function readJson(file, fallbackValue) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`Failed to read ${path.basename(file)}:`, err.message);
  }
  return fallbackValue;
}

function writeJsonSafe(file, data) {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error(`Failed to write ${path.basename(file)}:`, err.message);
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    return false;
  }
}

/** Clamps restored bounds to a currently-connected display. */
function sanitizeBounds(state) {
  if (!state || typeof state.width !== 'number') return null;
  const { screen } = require('electron');
  const area = screen.getDisplayMatching(state).workArea;

  const width = Math.min(Math.max(state.width, 900), area.width);
  const height = Math.min(Math.max(state.height, 600), area.height);
  const x = typeof state.x === 'number'
    ? Math.min(Math.max(state.x, area.x), area.x + area.width - width)
    : undefined;
  const y = typeof state.y === 'number'
    ? Math.min(Math.max(state.y, area.y), area.y + area.height - height)
    : undefined;

  return { width, height, x, y, maximized: Boolean(state.maximized) };
}

function saveWindowState(mainWindow) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const maximized = mainWindow.isMaximized();
  const bounds = mainWindow.getNormalBounds
    ? mainWindow.getNormalBounds()
    : mainWindow.getBounds();
  writeJsonSafe(windowStateFile(), { ...bounds, maximized });
}

module.exports = {
  userDataPath,
  settingsFile,
  windowStateFile,
  modelCacheDir,
  readJson,
  writeJsonSafe,
  sanitizeBounds,
  saveWindowState,
};
