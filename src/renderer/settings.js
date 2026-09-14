// Settings persistence (renderer side).
//
// The renderer stores only a couple of UI preferences (sidebar width/hidden).
// Everything goes through the secure preload bridge; failures are non-fatal.

import { api } from '../ai/api-bridge.js';
import { getAiPane, isSidebarHidden, toggleSidebar } from './sidebar.js';

let persistTimer = null;

export function persistSettings() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    api.saveSettings({
      sidebarWidth: getAiPane().style.width || '',
      sidebarHidden: isSidebarHidden(),
    });
  }, 400);
}

export async function restoreSettings() {
  try {
    const s = (await api.loadSettings()) || {};
    if (s.sidebarWidth) getAiPane().style.width = s.sidebarWidth;
    if (s.sidebarHidden) toggleSidebar(true);
  } catch {
    /* non-fatal */
  }
}
