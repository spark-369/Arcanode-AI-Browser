// Main window creation + lifecycle (main process).

const { BrowserWindow, shell, app } = require("electron");
const path = require("node:path");
const state = require("./state.js");
const views = require("./views.js");

/** Renderer origin. Anything else is untrusted web content. */
const APP_ORIGIN = "app://local/";

let mainWindow = null;

const createWindow = () => {
  // Idempotent: never stack a second window (would duplicate 'closed' listeners).
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  const restored = state.sanitizeBounds(
    state.readJson(state.windowStateFile(), null),
  );

  mainWindow = new BrowserWindow({
    width: restored?.width ?? 1440,
    height: restored?.height ?? 920,
    x: restored?.x,
    y: restored?.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0d12",
    title: "Arcanode AI Browser",
    icon: path.resolve(__dirname, "../../assets/desktop_icon.png"),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  // Each tab attaches ~11 event listeners to its webContents; raise the default
  // 10-listener EventEmitter limit so the console doesn't flood with warnings.
  mainWindow.setMaxListeners(50);
  mainWindow.webContents.setMaxListeners(50);

  if (restored?.maximized) mainWindow.maximize();

  // Load over the privileged app:// scheme so the renderer's ES modules (and
  // their imports) load with a real same-origin context.
  mainWindow.loadURL("app://local/index.html");

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // The shell lives on app://; never let it navigate away to untrusted content.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  let saveTimer = null;
  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => state.saveWindowState(mainWindow), 400);
  };
  mainWindow.on("resize", () => {
    queueSave();
    // Keep the active BrowserView filling the pane after a window resize.
    const entry = views.getActiveTabId()
      ? views.getView(views.getActiveTabId())
      : null;
    if (entry) views.applyBoundsToActive();
  });
  mainWindow.on("move", queueSave);
  mainWindow.on("close", () => {
    clearTimeout(saveTimer);
    state.saveWindowState(mainWindow);
  });
mainWindow.once("closed", () => {
      // Remove all listeners to prevent memory leaks
      mainWindow.removeAllListeners();
      mainWindow = null;
    });

    // Opened via `npm run dev`, or with OPEN_DEVTOOLS=1 set.
    const wantDevTools =
      process.argv.includes("--dev-devtools") ||
      process.env.OPEN_DEVTOOLS === "1";
    if (!app.isPackaged && wantDevTools) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }

    return mainWindow;
  };

function getMainWindow() {
  return mainWindow;
}

module.exports = { createWindow, getMainWindow, APP_ORIGIN };
