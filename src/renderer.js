// Renderer entry point. Wires together focused modules: tabs.js (multi-tab
// BrowserView manager), renderer/toolbar (omnibox, nav, load bar, errors),
// renderer/sidebar (resizer, toggle, launcher, modal), renderer/features (all
// on-device AI), renderer/theme (URL → sidebar color), renderer/engine-ui
// (status, progress, toasts), renderer/settings. The AI engine runs in the main
// process; this file talks to it over the secure bridge (see src/ai/).

import { api, hasBridge } from '../ai/api-bridge.js';
import { ai, initEngine, onProgress, cancel } from '../ai/client.js';
import { TabManager, HOME_URL } from '../tabs.js';

import { $, $$, normalizeUrl } from './renderer/dom.js';
import { syncToolbar, initToolbar, getUrlInput } from './renderer/toolbar.js';
import {
  initResizer,
  toggleSidebar,
  initLauncher,
} from './renderer/sidebar.js';
import { addHistory } from './renderer/history.js';
import {
  initHeadlineFeatures,
  initFeatureLaunchers,
  setEngineReady,
  bindTabs,
  runFeatureByName,
} from './renderer/features.js';
import { embeddingToTheme, applyTheme } from './renderer/theme.js';
import {
  setEngine,
  onProgress as onEngineProgress,
  onCancelClick,
  toast,
} from './renderer/engine-ui.js';
import { restoreSettings } from './renderer/settings.js';

// ---------------------------------------------------------------------------
// Tab manager
// ---------------------------------------------------------------------------

function getPaneBounds() {
  const browserPane = document.querySelector('.browser-pane');
  const rect = browserPane.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

const tabs = new TabManager({
  stripEl: $('#tabstrip-tabs'),
  onChange: (tab) => syncToolbar(tab, { onAutoTheme: autoThemeForUrl }),
  getBounds: getPaneBounds,
});

bindTabs(tabs);

// ---------------------------------------------------------------------------
// Network status: auto-retry ALL tabs when connectivity returns
// ---------------------------------------------------------------------------
function onBackOnline() {
  for (const tab of tabs.tabs) {
    if (!tab) continue;
    tab.loading = true;
    tabs.render();
    api.viewReload?.(tab.id, { bypassCache: true });
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', onBackOnline);
  window.addEventListener('offline', () => {
    for (const tab of tabs.tabs) {
      if (!tab) continue;
      if (tab.url !== HOME_URL) {
        tab.loading = true;
        tabs.render();
        if (tab.id === tabs.activeId) {
          tabs.onChange(tabs.active);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------

initToolbar({
  tabs,
  onNavigate: (value) => tabs.navigate(normalizeUrl(value)),
  onBack: () => tabs.back(),
  onForward: () => tabs.forward(),
  onReload: () => tabs.reload(),
  onHome: () => tabs.navigate(HOME_URL),
  onEnter: (value) => tabs.navigate(normalizeUrl(value)),
});

// Guest pages that try to open a new window arrive here from the main process.
api.onOpenUrl?.((url) => tabs.open(url));

// Keep the active BrowserView filling the pane on window resize.
window.addEventListener('resize', () => tabs.syncBounds());

// First tab.
tabs.open(HOME_URL);

// ---------------------------------------------------------------------------
// Sidebar wiring
// ---------------------------------------------------------------------------

initResizer(tabs);
initLauncher();
$('#btn-toggle-sidebar').addEventListener('click', () => toggleSidebar());

// Record every navigation into the on-device history (IndexedDB).
const _nav = tabs.navigate.bind(tabs);
tabs.navigate = (url, ...rest) => {
  addHistory(url);
  return _nav(url, ...rest);
};

// ---------------------------------------------------------------------------
// AI features wiring
// ---------------------------------------------------------------------------

initHeadlineFeatures();
initFeatureLaunchers();

// ---------------------------------------------------------------------------
// Engine progress + status
// ---------------------------------------------------------------------------

onProgress((p) => onEngineProgress(p));
onCancelClick((id) => cancel(id));

// ---------------------------------------------------------------------------
// Auto-theming from the active page URL
// ---------------------------------------------------------------------------

let engineReady = false;
let themeTimer = null;
let themeUrl = null;

function autoThemeForUrl(url) {
  if (!url || !engineReady) return;
  if (url === themeUrl) return;
  themeUrl = url;
  clearTimeout(themeTimer);
  themeTimer = setTimeout(async () => {
    try {
      const result = await ai.embed(url);
      const embedding = result?.embedding;
      if (!Array.isArray(embedding) || !embedding.length) return;
      applyTheme(embeddingToTheme(embedding));
    } catch {
      /* non-fatal: keep the previous theme */
    }
  }, 600);
}

// ---------------------------------------------------------------------------
// Menu commands from the main process
// ---------------------------------------------------------------------------

api.onMenuCommand?.((command) => {
  switch (command) {
    case 'new-tab': tabs.open(HOME_URL); break;
    case 'close-tab': if (tabs.active) tabs.close(tabs.active.id); break;
    case 'reload': tabs.reload(); break;
    case 'focus-address': getUrlInput().focus(); break;
    case 'toggle-sidebar': toggleSidebar(); break;
    case 'summarize': runFeatureByName('summarize'); $('#btn-summarize').click(); break;
    case 'ask': runFeatureByName('ask'); $('#ask-input').focus(); break;
    case 'search': runFeatureByName('search'); $('#search-input').focus(); break;
    case 'tone': runFeatureByName('tone'); $('#btn-tone').click(); break;
    case 'cache-cleared': toast('Model cache cleared', 'success'); break;
  }
});

// ---------------------------------------------------------------------------
// Global keyboard shortcuts (belt-and-braces alongside the menu accelerators)
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'l') { e.preventDefault(); getUrlInput().focus(); }
  else if (mod && e.key === 't') { e.preventDefault(); tabs.open(HOME_URL); }
  else if (mod && e.key === 'w') { e.preventDefault(); if (tabs.active) tabs.close(tabs.active.id); }
  else if (mod && e.key === 'r') { e.preventDefault(); tabs.reload(); }
  else if (mod && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
  else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); tabs.back(); }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); tabs.forward(); }
});

// ---------------------------------------------------------------------------
// Copy buttons
// ---------------------------------------------------------------------------

$$('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = $(`#${btn.dataset.copy}`);
    const text = target?.innerText.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard', 'success', 1400);
    } catch {
      toast('Could not copy', 'error');
    }
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  await restoreSettings();

  if (!hasBridge) {
    toast('Running without the secure bridge — some features are disabled.', 'error', 5000);
  }

  setEngine('busy', 'Starting engine…');
  try {
    await initEngine();
    engineReady = true;
    setEngineReady(true);
    setEngine('ready', 'Ready');
  } catch (err) {
    engineReady = false;
    setEngineReady(false);
    setEngine('error', 'Engine failed');
    console.error('Engine init failed:', err);
    toast('The local AI engine failed to start. Try reinstalling dependencies.', 'error', 6000);
  }
}

boot();
