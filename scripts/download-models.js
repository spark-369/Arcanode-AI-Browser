#!/usr/bin/env node
/**
 * One-time model downloader for Arcanode AI Browser.
 *
 * Run this ONCE on a machine/network that can reach huggingface.co:
 *
 *     node scripts/download-models.js
 *
 * It uses the exact same @xenova/transformers library the app runs, so the
 * weights land in the precise layout the app reads from
 * `<userData>/models` (i.e. `env.cacheDir`). After this completes, the app
 * works fully offline — no further network access is needed.
 *
 * To pre-seed a different machine, copy the resulting `models/` folder into
 * that machine's userData directory:
 *   - Linux:   ~/.config/Arcanode AI Browser/models
 *   - macOS:   ~/Library/Application Support/Arcanode AI Browser/models
 *   - Windows: %APPDATA%\Arcanode AI Browser\models
 */

const dns = require('node:dns');
// Force IPv4-first: this host's DNS returns IPv6 (AAAA) records that Node's
// undici fetch attempts and times out on, instead of falling back to IPv4.
dns.setDefaultResultOrder('ipv4first');
// Force IPv4 for model downloads (see module for why).
require('../src/ai/net-ipv4.js');

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { pipeline, env } = require('@xenova/transformers');

// Mirror the app's cache location (Electron's userData) so the download
// lands where the app looks. We resolve the home directory from $HOME and
// normalize it, because on some setups os.homedir() returns a doubled path
// (e.g. /home/user/home/user), which would put the cache in the wrong place.
function resolveHome() {
  const candidates = [
    process.env.HOME,
    process.env.USERPROFILE,
    os.homedir(),
  ].filter(Boolean);

  // Some environments report a doubled home (e.g. /home/x/home/x). Generate
  // both the raw and collapsed forms, then prefer the shortest one that
  // actually exists on disk (the real home almost always does).
  const forms = new Set();
  for (const c of candidates) {
    forms.add(path.resolve(c));
    const m = c.match(/^(\/[^/]+\/[^/]+)\1(\/.*)?$/);
    if (m) forms.add(path.resolve(m[1] + (m[2] || '')));
  }

  // Also derive the home from the current user's passwd entry — this is
  // immune to a mis-set $HOME and matches what Electron's userData resolves to.
  try {
    const pw = os.userInfo();
    if (pw && pw.homedir) forms.add(path.resolve(pw.homedir));
  } catch {
    /* ignore */
  }

  const existing = [...forms].filter((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  if (existing.length) return existing.sort((a, b) => a.length - b.length)[0];

  // Fall back to the shortest candidate.
  return [...forms].sort((a, b) => a.length - b.length)[0];
}
const home = resolveHome();
const userDataDir = path.join(
  home,
  process.platform === 'darwin'
    ? 'Library/Application Support'
    : process.platform === 'win32'
      ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : path.join(home, '.config')
);
let cacheDir = path.join(userDataDir, 'Arcanode AI Browser', 'models');

// Defensive: if the resolved cache dir does not already hold models but a
// "collapsed" variant of the same path does (e.g. a doubled $HOME produced
// /home/x/home/x/.config/...), prefer the one that already has the weights so
// we never download into the wrong place.
if (!fs.existsSync(path.join(cacheDir, 'Xenova'))) {
  const collapsed = cacheDir.replace(/^(\/home\/[^/]+)\1(\/.*)?$/, '$1$2');
  if (collapsed !== cacheDir && fs.existsSync(path.join(collapsed, 'Xenova'))) {
    cacheDir = collapsed;
  }
}

env.cacheDir = cacheDir;
env.localModelPath = cacheDir;
env.allowLocalModels = true;
env.allowRemoteModels = true;

// Same registry the app uses (src/ai/engine/config.js). Only the models the app
// actually wires up are pre-seeded here.
const MODELS = {
  summarization: 'Xenova/distilbart-cnn-6-6',
  'question-answering': 'Xenova/distilbert-base-cased-distilled-squad',
  'feature-extraction': 'Xenova/all-MiniLM-L6-v2',
  'token-classification': 'Xenova/bert-base-NER',
  'zero-shot-classification': 'Xenova/distilbert-base-uncased-mnli',
  'sentiment': 'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
  'toxicity': 'Xenova/toxic-bert',
  'emotion': 'MicahB/roberta-base-go_emotions',
};

const TASKS = {
  summarization: 'summarization',
  'question-answering': 'question-answering',
  'feature-extraction': 'feature-extraction',
  'token-classification': 'token-classification',
  'zero-shot-classification': 'zero-shot-classification',
  'sentiment': 'text-classification',
  'toxicity': 'text-classification',
  'emotion': 'text-classification',
};

async function download(name, task) {
  console.log(`\n→ Downloading ${name} (${task})…`);
  const pipe = await pipeline(task, name, {
    quantized: true,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        const pct = Math.round((p.loaded / p.total) * 100);
        process.stdout.write(`\r   ${p.file || ''} ${pct}%`);
      } else if (p.status === 'done') {
        process.stdout.write('\r   done\n');
      }
    },
  });
  // Touch the pipeline once so any lazy files are also fetched.
  if (task === 'summarization') await pipe('warmup test sentence.', { max_new_tokens: 8 });
  if (task === 'question-answering') await pipe('What is this?', 'This is a warmup context.', { topk: 1 });
  if (task === 'feature-extraction') await pipe('warmup', { pooling: 'mean', normalize: true });
  console.log(`✓ ${name} ready`);
}

(async () => {
  fs.mkdirSync(cacheDir, { recursive: true });
  console.log(`Caching models into:\n  ${cacheDir}\n`);
  for (const [key, name] of Object.entries(MODELS)) {
    try {
      await download(name, TASKS[key]);
    } catch (err) {
      console.error(`\n✗ Failed to download ${name}: ${err.message}`);
      console.error('  Check your internet connection and that huggingface.co is reachable.');
      process.exitCode = 1;
    }
  }
  console.log('\nAll done. You can now run the app fully offline.');
})();
