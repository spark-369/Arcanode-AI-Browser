# Arcanode AI Browser

**Arcanode AI Browser** is a privacy-focused desktop web browser with an on-device AI workspace. It combines a multi-tab browsing experience with local text analysis powered by Transformers.js and ONNX Runtime. Model inference runs in a dedicated child process, and model weights are cached locally for offline use after their first download.

## Overview

The application is built with Electron and is organized into three main runtime areas:

- A main-process browser shell that owns windows, navigation, sessions, state, and IPC.
- A renderer shell that provides the tab strip, toolbar, sidebar, settings, and history UI.
- A separate Node.js engine worker that loads Transformers.js models and performs inference.

The browser opens ordinary web pages in native `WebContentsView` instances. The AI sidebar analyzes readable text from the active page or the user's current text selection. The browser does not block web traffic: its privacy guarantee applies to AI inference, not to the websites a user chooses to visit.

## Key Features

### Browser

- Multiple tabs backed by persistent native Electron `WebContentsView` instances.
- URL omnibox with DuckDuckGo search fallback.
- Back, forward, reload, stop, and home controls.
- Loading progress indicator and page-load error overlay.
- Favicon retrieval and inlining in the tab strip.
- Per-URL history stored in IndexedDB with filtering, reopening, individual deletion, and clear-all support.
- Persistent window bounds, sidebar visibility, and sidebar width.
- Automatic sidebar color theming derived from the active page URL.
- New tabs are reopened automatically when the final tab is closed.

### On-device AI

The AI launcher provides tools for:

- Summarization and extractive question answering.
- Semantic search and related-passage search.
- Sentiment, emotion, tone, toxicity, intent, topic, language, formality, and factuality classification.
- Named-entity extraction, including people, places, organizations, and acronyms.
- Keywords, keyphrases, highlights, outlines, clusters, and deduplication.
- Reading-time, coherence, and simplicity estimates.
- Action-item, FAQ, claim, question, glossary, quote, number, and date extraction.
- Zero-shot classification with custom labels.
- Claim contradiction checks using natural-language inference.
- Bias detection, sarcasm estimation, urgency estimation, political lean estimation, target audience age estimation, and genre detection.
- Duplicate sentence detection and keyphrase extraction.

Most tools analyze the current text selection when one exists. Otherwise, they analyze readable text extracted from the active page. Some tools require an additional input such as a question, search query, custom labels, a reference snippet, or a claim.

## Technology Stack

- Electron 44
- Node.js
- Transformers.js (`@xenova/transformers`)
- ONNX Runtime through the native Transformers.js backend
- Electron Forge for packaging
- IndexedDB for on-device browsing history
- Plain HTML, CSS, and browser-side ES modules

## Project Structure

```text
ai-local-browser/
├── package.json
├── package-lock.json
├── forge.config.js
├── .gitignore
├── README.md
├── scripts/
│   └── download-models.js
└── src/
    ├── index.js
    ├── index.html
    ├── index.css
    ├── preload.js
    ├── tabs.js
    ├── renderer.js
    ├── main/
    │   ├── window.js
    │   ├── views.js
    │   ├── ipc.js
    │   ├── state.js
    │   └── menu.js
    ├── ai/
    │   ├── api-bridge.js
    │   ├── client.js
    │   ├── engine-host.js
    │   ├── engine-worker.js
    │   ├── net-ipv4.js
    │   └── engine/
    │       ├── config.js
    │       ├── index.js
    │       ├── handlers.js
    │       ├── util.js
    │       └── errors.js
    ├── renderer/
    │   ├── dom.js
    │   ├── toolbar.js
    │   ├── sidebar.js
    │   ├── features.js
    │   ├── engine-ui.js
    │   ├── theme.js
    │   ├── settings.js
    │   └── history.js
    └── styles/
        ├── base.css
        ├── tabs.css
        ├── toolbar.css
        ├── layout.css
        ├── sidebar.css
        ├── components.css
        └── features.css
```

## Architecture

### Main process

`src/index.js` is the Electron entry point. It registers the privileged `app://` scheme, initializes the local AI engine host, configures Chromium runtime flags, sets up session permissions, and wires the application modules together.

The main process is responsible for:

- Creating the application window.
- Managing persistent browser tabs and their `WebContentsView` instances.
- Performing navigation and page-state tracking.
- Fetching favicons for the shell UI.
- Persisting settings and window state.
- Handling renderer IPC requests.
- Building the application menu.
- Starting and stopping the AI worker process.

#### View manager

`src/main/views.js` manages per-tab `WebContentsView` instances (the modern replacement for the deprecated `BrowserView`). Only the active view is painted at a time; inactive views keep their page state alive off-screen. Views are kept permanently attached to the window's `contentView` and simply toggled with `setVisible()`, which avoids a long-standing `BrowserView` bug where repeatedly removing and re-adding a view renders it blank when switching tabs. The renderer drives everything over IPC and receives state changes as events.

### Renderer process

The renderer is served from `app://local/index.html` as an ES-module application. It contains no direct Node.js or Electron access. It communicates with the main process through the narrow API exposed by `src/preload.js`.

The renderer handles:

- Tab strip and toolbar rendering.
- URL normalization and navigation controls.
- AI launcher cards and generated feature panels.
- Progress, status, cancellation, and toast UI.
- IndexedDB browsing history.
- Sidebar resizing and persistence.
- Page-derived visual theming.

### AI engine worker

`src/ai/engine-host.js` forks `src/ai/engine-worker.js` as a separate OS child process using `child_process.fork`. The worker loads model pipelines and runs inference using the native ONNX backend. Because it runs in its own process, a crash, segfault, or out-of-memory failure in the native model runtime can never take down the browser window — only the worker dies, and the host reports the failure gracefully. In a packaged build the worker is resolved from `app.asar.unpacked`, with its `node_modules` added to `NODE_PATH` so the native ONNX runtime resolves at runtime.

The engine supports:

- Pipeline caching by task and model.
- Download and inference progress events.
- Best-effort request cancellation.
- A 180-second request timeout.
- Normalized user-facing errors for network, memory, and model-loading failures.

### IPC bridge

`src/preload.js` exposes `window.api` through `contextBridge`. The renderer can request only explicitly exposed capabilities, including:

- Application information and external URL opening.
- Settings load and save operations.
- Model-cache statistics and clearing.
- AI initialization, execution, cancellation, and progress events.
- Tab creation, destruction, activation, navigation, history controls, and text extraction.
- Menu command events and page-load state events.

## Security and Privacy

AI inference is designed to run locally. Model weights are downloaded from Hugging Face only when needed and are then cached under the application data directory. The engine does not send page text to a cloud inference service.

The application hardening includes:

- `contextIsolation: true`.
- `nodeIntegration: false`.
- A restricted preload bridge with no raw `ipcRenderer` exposure.
- A strict Content Security Policy for the app shell.
- Denied camera, microphone, and geolocation permission requests.
- Prevention of nested webviews and uncontrolled guest window creation.
- Shell navigation protection for non-`app://` origins.
- Single-instance locking to avoid concurrent access to settings and model caches.
- Electron Forge fuses that disable Node inspection and related runtime escape options in packaged builds.

The web browsing area remains capable of loading arbitrary websites. Users should therefore apply normal browser safety practices when visiting untrusted pages.

## Requirements

- Node.js 18 or newer for development tooling.
- npm.
- A graphical environment with X11 support on Linux. The default scripts pass `--ozone-platform=x11`.
- Network access for the first model download, unless models are pre-cached.
- Sufficient disk space and memory for the selected models.

The packaged application includes Electron and does not require a separate Node.js installation at runtime.

## Installation

From the project root:

```bash
cd ai-local-browser
npm install
```

The repository includes `package-lock.json`, so `npm ci` can be used for a reproducible dependency installation:

```bash
npm ci
```

## Running the Application

```bash
npm start
```

`npm start` launches Electron with `--ozone-platform=x11`.

For a development run with detached DevTools (works when `app.isPackaged` is false):

```bash
OPEN_DEVTOOLS=1 npm start
```

On first launch, the application initializes the AI engine. The first use of an AI tool downloads the required model into the local cache. Subsequent uses can run without network access.

## Model Cache

The engine stores models in Electron's `userData/models` directory:

| Platform | Default model cache |
| --- | --- |
| Linux | `~/.config/Arcanode AI Browser/models` |
| macOS | `~/Library/Application Support/Arcanode AI Browser/models` |
| Windows | `%APPDATA%\Arcanode AI Browser\models` |

To download the configured model set before using the application offline:

```bash
npm run download-models
```

The downloader uses the same Transformers.js configuration and cache layout as the application. It pre-seeds the full configured model set with quantized weights enabled:

| Model | Covers |
| --- | --- |
| `Xenova/distilbart-cnn-6-6` | Summarization |
| `Xenova/distilbert-base-cased-distilled-squad` | Question answering |
| `Xenova/all-MiniLM-L6-v2` | Text embeddings, search, keywords, clustering, deduplication, and other embedding-based tools |
| `Xenova/bert-base-NER` | Named-entity recognition (people, places, organizations, acronyms) |
| `Xenova/distilbert-base-uncased-mnli` | Zero-shot classification, topic, intent, language, formality, contradiction, and natural-language inference |
| `Xenova/distilbert-base-uncased-finetuned-sst-2-english` | Sentiment classification |
| `Xenova/toxic-bert` | Toxicity classification |
| `MicahB/roberta-base-go_emotions` | Emotion / tone classification |

The model cache can also be cleared from the application menu through **AI > Clear Model Cache...**. Clearing it requires the models to be downloaded again when their tools are next used.

## IndexedDB Storage

Browsing history is stored entirely on-device using the browser-native **IndexedDB** API. History is recorded and managed directly in the renderer process (see `src/renderer/history.js`) — nothing is sent to a network or through the main process.

| Setting | Value |
| --- | --- |
| Database name | `ai-local-browser` |
| Database version | `1` |
| Object store | `history` (keyed by URL) |
| Index | `visitedAt` (visit timestamp) |

Each history record captures the page URL, title, favicon, and the timestamp of the most recent visit. Entries are deduplicated by URL (the newest visit is kept and sorted first), and the History panel supports filtering, reopening, deleting individual entries, and clearing all entries.

Because the history lives in the renderer's IndexedDB, it is isolated to the on-device browsing session and can be cleared from the History panel without affecting settings or the model cache.

## Usage

### Browsing

- New tab: `Ctrl/Cmd+T`
- Close tab: `Ctrl/Cmd+W`
- Focus address bar: `Ctrl/Cmd+L`
- Reload: `Ctrl/Cmd+R`
- Back: `Alt+Left`
- Forward: `Alt+Right`
- Toggle AI sidebar: `Ctrl/Cmd+B`

The omnibox accepts full URLs, bare domains, localhost addresses, and search queries. Search queries open DuckDuckGo.

### AI tools

1. Open the AI sidebar.
2. Select a tool from the launcher grid.
3. Enter any required tool-specific input.
4. Click **Run**, or press Enter in an input field.
5. Monitor download or inference progress in the sidebar footer.
6. Use **Stop** to request cancellation of an in-flight run.

Results can be copied from the output area where a copy control is available.

If the page text exceeds a model's input limit, the sidebar shows a centered warning with the character count and the limit, and suggests selecting a smaller portion of the page before retrying.

## Configuration and Development

### Package scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Launch the application with X11 Ozone flags |
| `npm run download-models` | Pre-download configured model weights |
| `npm run lint` | Run the linter (currently a placeholder; no linter is configured) |
| `npm run package` | Create an unpackaged Electron application |
| `npm run make` | Create platform distributables |
| `npm run publish` | Build and publish through configured Forge publishing |

### Packaging

`forge.config.js` defines the application name, bundle identifier, executable name, ASAR packaging, native dependency unpacking, and Forge makers.

Configured makers include:

- Squirrel installer for Windows.
- ZIP archive for macOS.
- DEB package for Linux (with a desktop icon).

The Linux executable is named `ai-local-browser`; other platforms use the product name `Arcanode AI Browser`.

### Adding an AI feature

1. Add the task and model mapping in `src/ai/engine/config.js`.
2. Add a corresponding handler in `src/ai/engine/handlers.js`.
3. Expose the task through the renderer client in `src/ai/client.js`.
4. Add a launcher card in `src/index.html`.
5. Add the feature registry entry in `src/renderer/features.js`.

The feature registry controls panel generation, input requirements, argument mapping, and result rendering.

## Troubleshooting

### The application window is blank or unstyled

Confirm that the privileged `app://` scheme is registered before `app.whenReady()` and that it is registered for both the default session and the `persist:ailocal` session used by browser tabs.

### AI tools remain in the starting state

Check the application console for engine initialization errors. Reinstall dependencies if the worker cannot start, and verify that the model cache directory is writable.

### A model cannot be downloaded

Check internet connectivity and access to Hugging Face. The engine forces IPv4-first DNS and an IPv4-capable HTTP dispatcher to work around networks where IPv6 attempts time out.

### A request times out

Large pages or memory-heavy models can exceed the 180-second limit. Select a smaller portion of text, shorten the page content, or restart the application after an out-of-memory failure.

### Packaged builds cannot load the engine

Verify that native dependencies are unpacked by Electron Forge's auto-unpack plugin and that the package was built with the expected platform toolchain.

## License

MIT. See `package.json` for project metadata and licensing information.
