// Toolbar: omnibox, navigation buttons, load progress bar, and the page
// error overlay. It is driven by the active tab's state (passed in via
// syncToolbar) and reports user actions back through callbacks.

import { $, prettyUrl } from './dom.js';

const urlInput = $('#url-input');
const loadBar = $('#load-bar');
const omniboxLead = $('#omnibox-lead');

const btnBack = $('#btn-back');
const btnForward = $('#btn-forward');
const reloadIcon = $('#reload-icon');

let loadCreepTimer = null;
let loadHideTimer = null;
let urlFocused = false;

// Chromium gives no real load percentage for a webview, so the bar eases toward
// 90% while loading and snaps to 100% on completion.
function setLoadBar(loading) {
  clearInterval(loadCreepTimer);
  clearTimeout(loadHideTimer);

  if (loading) {
    loadBar.classList.add('active');
    let w = 18;
    loadBar.style.width = `${w}%`;
    loadCreepTimer = setInterval(() => {
      w = Math.min(w + (90 - w) * 0.12, 90);
      loadBar.style.width = `${w}%`;
    }, 220);
  } else {
    loadBar.style.width = '100%';
    loadHideTimer = setTimeout(() => {
      loadBar.classList.remove('active');
      loadBar.style.width = '0';
    }, 260);
  }
}

function setLeadIcon(url) {
  omniboxLead.className = 'omnibox-lead';
  let icon = '#i-search';
  if (/^https:/i.test(url)) {
    omniboxLead.classList.add('secure');
    icon = '#i-lock';
  } else if (/^http:/i.test(url)) {
    omniboxLead.classList.add('insecure');
    icon = '#i-warn';
  }
  omniboxLead.innerHTML = `<svg class="ic"><use href="${icon}" /></svg>`;
}

export function syncToolbar(tab, { onAutoTheme } = {}) {
  if (!tab) return;
  if (!urlFocused) urlInput.value = prettyUrl(tab.url);
  btnBack.disabled = !tab.canGoBack;
  btnForward.disabled = !tab.canGoForward;
  setLoadBar(tab.loading);
  setLeadIcon(tab.url);
  if (typeof onAutoTheme === 'function') onAutoTheme(tab.url);
}

export function initToolbar({ onNavigate, onBack, onForward, onReload, onHome, onEnter, tabs }) {
  $('#btn-go').addEventListener('click', () => onNavigate(urlInput.value));
  btnBack.addEventListener('click', () => onBack());
  btnForward.addEventListener('click', () => onForward());
  $('#btn-reload').addEventListener('click', () => onReload());
  $('#btn-home').addEventListener('click', () => onHome());
  $('#btn-new-tab').addEventListener('click', () => tabs.open());

  urlInput.addEventListener('focus', () => {
    urlFocused = true;
    urlInput.select();
  });
  urlInput.addEventListener('blur', () => {
    urlFocused = false;
    if (tabs.active) urlInput.value = prettyUrl(tabs.active.url);
  });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      onEnter(urlInput.value);
      urlInput.blur();
    } else if (e.key === 'Escape') {
      if (tabs.active) urlInput.value = prettyUrl(tabs.active.url);
      urlInput.blur();
    }
  });
}

export function getUrlInput() {
  return urlInput;
}
