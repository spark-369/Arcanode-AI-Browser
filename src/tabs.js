// Multi-tab BrowserView manager (renderer side). Each tab is backed by a
// persistent BrowserView created in the MAIN process (index.js); the renderer
// keeps only tab metadata and drives the views through the preload bridge. The
// main process pushes state back via onViewState. The manager is
// UI-agnostic: it renders the tab strip and emits a single `onChange`.

import { api } from './ai/api-bridge.js';

const HOME_URL = 'https://duckduckgo.com';

let seq = 0;

export class TabManager {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.stripEl   container for tab buttons
   * @param {Function}    opts.onChange  called whenever the active tab's state changes
   * @param {Function}    opts.getBounds returns the browser-pane rect {x,y,width,height}
   */
  constructor({ stripEl, onChange, getBounds }) {
    this.stripEl = stripEl;
    this.onChange = onChange || (() => {});
    this.getBounds = getBounds || (() => ({ x: 0, y: 0, width: 0, height: 0 }));
    this.tabs = [];
    this.activeId = null;

    // Delegated handlers so tab buttons need no per-element listeners.
    this.stripEl.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('.tab-close');
      const item = e.target.closest('.tab-item');
      if (!item) return;
      const id = item.dataset.id;
      if (closeBtn) {
        e.stopPropagation();
        this.close(id);
      } else {
        this.activate(id);
      }
    });

    // Middle-click closes, matching normal browser behaviour.
    this.stripEl.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      const item = e.target.closest('.tab-item');
      if (item) {
        e.preventDefault();
        this.close(item.dataset.id);
      }
    });

        // State pushed from the main process.
    api.onViewState?.(({ tabId, ...state }) => {
      const tab = this.getById(tabId);
      if (!tab) return;
      Object.assign(tab, state);
      this.render();
      if (tabId === this.activeId) this.#emit();
    });
  }

  get active() {
    return this.tabs.find((t) => t.id === this.activeId) || null;
  }

  getById(id) {
    return this.tabs.find((t) => t.id === id) || null;
  }

  // ------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------

  async open(url = HOME_URL, { activate = true } = {}) {
    const id = `tab-${++seq}`;

    const tab = {
      id,
      url,
      title: 'New tab',
      favicon: '',
      loading: true,
      canGoBack: false,
      canGoForward: false,
      error: null,
    };

    this.tabs.push(tab);

    // Ask the main process to create the underlying BrowserView. The main
    // process owns navigation and storage decisions, so the renderer never
    // touches storage or passes a blob.
    try {
      await api.viewCreate(id, url);
    } catch (err) {
      console.error('Failed to create view:', err);
    }

    if (activate) this.activate(id);
    else this.render();

    return tab;
  }

  async close(id) {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index === -1) return;

    this.tabs.splice(index, 1);
    try {
      await api.viewDestroy(id);
    } catch {
      /* best effort */
    }

    if (this.tabs.length === 0) {
      // Never leave the window empty; behave like a normal browser.
      this.open(HOME_URL);
      return;
    }

    if (this.activeId === id) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      this.activate(next.id);
    } else {
      this.render();
    }
  }

  async activate(id) {
    const tab = this.getById(id);
    if (!tab) return;

    this.activeId = id;
    this.render();

    // Tell the main process which view to show and where to put it.
    try {
      await api.viewSetActive(id);
      await api.viewSetBounds(this.getBounds());
    } catch (err) {
      console.error('Failed to activate view:', err);
    }

    this.#emit();
  }

  /** Push the current pane rectangle so the active view fills it. */
  syncBounds() {
    if (!this.activeId) return;
    api.viewSetBounds?.(this.getBounds());
  }

  #emit() {
    this.onChange(this.active);
  }

  // ------------------------------------------------------------------------
  // Navigation helpers (operate on the active tab)
  // ------------------------------------------------------------------------

  async navigate(url) {
    const tab = this.active;
    if (!tab) return;
    tab.url = url;
    tab.loading = true;
    this.render();
    this.#emit();
    // Always force a fresh online fetch — if offline, the request
    // will naturally fail and the error page will show.
    api.viewNavigate?.(tab.id, url, { bypassCache: true });
  }

  back() {
    const t = this.active;
    if (t?.canGoBack) api.viewBack?.(t.id);
  }

  forward() {
    const t = this.active;
    if (t?.canGoForward) api.viewForward?.(t.id);
  }

  async reload() {
    const t = this.active;
    if (!t) return;
    // Optimistically clear the error state and show loading so the error
    // overlay disappears immediately, before the main process confirms.
    t.error = null;
    t.loading = true;
    this.render();
    this.#emit();
    api.viewReload?.(t.id, { bypassCache: true });
  }

  stop() {
    this.active && api.viewStop?.(this.active.id);
  }

  /** Extracts the user's current text selection from the active page. The
   *  selection is read from the page's own DOM via the main process and passed
   *  straight to the AI as context. */
  async getSelection() {
    const tab = this.active;
    if (!tab) return '';
    try {
      return (await api.viewGetSelection(tab.id, '')) || '';
    } catch (err) {
      console.warn('Selection extraction failed:', err);
      return '';
    }
  }

  /** Extracts the readable text of the active page (falls back to selection). */
  async getText() {
    const tab = this.active;
    if (!tab) return '';
    try {
      return (await api.viewGetText(tab.id)) || '';
    } catch (err) {
      console.warn('Page text extraction failed:', err);
      return '';
    }
  }

  // ------------------------------------------------------------------------
  // Tab strip rendering
  // ------------------------------------------------------------------------

  render() {
    // Rebuild the strip. The views live in the main process, so this is cheap
    // and cannot disturb page state.
    this.stripEl.replaceChildren(
      ...this.tabs.map((tab) => {
        const el = document.createElement('div');
        el.className = `tab-item${tab.id === this.activeId ? ' active' : ''}`;
        el.dataset.id = tab.id;
        el.title = tab.title || tab.url;

        if (tab.loading) {
          const spinner = document.createElement('span');
          spinner.className = 'tab-spinner';
          el.appendChild(spinner);
        } else if (tab.favicon) {
          const img = document.createElement('img');
          img.className = 'tab-favicon';
          img.src = tab.favicon;
          // A broken favicon must not leave a broken-image glyph behind.
          img.addEventListener('error', () => img.remove());
          el.appendChild(img);
        } else {
          const dot = document.createElement('span');
          dot.className = 'tab-favicon';
          el.appendChild(dot);
        }

        const title = document.createElement('span');
        title.className = 'tab-title';
        // textContent, never innerHTML: page titles are attacker-controlled.
        title.textContent = tab.loading && tab.title === 'New tab' ? 'Loading…' : tab.title;
        el.appendChild(title);

        const close = document.createElement('button');
        close.className = 'tab-close';
        close.title = 'Close tab';
        close.innerHTML = '<svg class="ic"><use href="#i-close" /></svg>';
        el.appendChild(close);

        return el;
      })
    );
  }
}

export { HOME_URL };
