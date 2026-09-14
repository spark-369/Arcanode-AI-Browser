// AI engine host (runs in the Electron main process).
const { fork } = require("child_process");
const path = require("node:path");
const { app } = require("electron");

const RUN_TIMEOUT_MS = 180_000;
// Keep message ids within the safe-integer range even in long-lived sessions.
const MSG_ID_MAX = Number.MAX_SAFE_INTEGER;

class EngineHost {
  constructor() {
    this.child = null;
    this.ready = false;
    this.started = false;
    this.failed = false; // set when the worker died/crashed before becoming ready
    this.progressSink = null;
    this.pending = new Map(); // msgId -> { resolve, reject, timer, requestId }
    this.nextMsgId = 1;
    this.windowId = 1;
    this.readyResolvers = [];
    this.reqToFull = new Map(); // bare requestId -> full engine id
    this.lastCacheDir = null;
  }

  init(cacheDir) {
    if (cacheDir) this.lastCacheDir = cacheDir;
    if (this.started) return this.#readyPromise();
    this.started = true;
    this.failed = false;

    const forkEnv = { ...process.env };

    // In a packaged build the forked worker lives under app.asar.unpacked; add
    // its node_modules to NODE_PATH so native ONNX resolves at runtime.
    if (app.isPackaged) {
      const unpackedRoot = app
        .getAppPath()
        .replace(/\.asar$/, ".asar.unpacked");
      const unpackedNodeModules = path.join(unpackedRoot, "node_modules");

      forkEnv.NODE_PATH = [forkEnv.NODE_PATH, unpackedNodeModules, unpackedRoot]
        .filter(Boolean)
        .join(path.delimiter);
    }

    const workerPath = app.isPackaged
      ? path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "src",
          "ai",
          "engine-worker.js",
        )
      : path.join(__dirname, "engine-worker.js");

    this.child = fork(workerPath, [], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: forkEnv,
    });

    this.child.on("message", (msg) => this.#onMessage(msg));

    this.child.on("exit", (code, signal) => {
      this.ready = false;
      this.started = false;
      this.failed = true;
      console.error(
        `AI engine worker exited (code ${code}, signal ${signal}).`,
      );
      this.#failPending(
        new Error("The AI engine stopped unexpectedly. Please try again."),
      );
    });

    this.child.on("error", (err) => {
      this.ready = false;
      this.started = false;
      this.failed = true;
      console.error("AI engine worker error:", err.message);
      this.#failPending(
        new Error("The AI engine failed to start. Please restart the app."),
      );
    });

    // Hand the worker its model cache directory before any run arrives.
    this.#send("init", { cacheDir: this.lastCacheDir }, () => {});

    return this.#readyPromise();
  }

  // Resolves when the worker is ready, or rejects if it fails to start.
  #readyPromise() {
    if (this.ready) return Promise.resolve();
    if (this.failed) {
      return Promise.reject(
        new Error("The AI engine failed to start. Please restart the app."),
      );
    }
    return new Promise((resolve, reject) =>
      this.readyResolvers.push({ resolve, reject }),
    );
  }

  setProgressSink(fn) {
    this.progressSink = typeof fn === "function" ? fn : null;
  }

  async run(task, inputs, options = {}, model, id) {
    // Auto-restart the worker if it had stopped or crashed.
    if (!this.started || this.failed) {
      this.init(this.lastCacheDir);
    }

    // Wait until the worker is running and ready before sending the request.
    if (!this.ready) {
      await this.#readyPromise();
    }
    if (!this.child || !this.ready || this.failed) {
      throw new Error("The AI engine is not available. Please try again.");
    }

    return new Promise((resolve, reject) => {
      const windowId = Number(String(id).split(":")[0]) || this.windowId;
      const requestId = String(id).split(":")[1] || String(id) || "req";
      const fullId = `${windowId}:${requestId}`;

      this.reqToFull.set(requestId, fullId);

      const msgId = this.#nextId();

      const timer = setTimeout(() => {
        this.pending.delete(msgId);
        this.reqToFull.delete(requestId); // Clean up Map
        reject(
          new Error(
            "The AI engine took too long to respond. Please try again.",
          ),
        );
      }, RUN_TIMEOUT_MS);

      this.pending.set(msgId, { resolve, reject, timer, requestId });

      try {
        this.child.send({
          type: "run",
          id: msgId,
          task,
          inputs,
          options,
          model,
          requestId,
          windowId,
        });
      } catch (err) {
        // The worker died between the ready check and the send; surface the
        // failure instead of crashing the main process on a dead fd.
        clearTimeout(timer);
        this.pending.delete(msgId);
        reject(new Error("The AI engine is not available. Please try again."));
      }
    });
  }

  cancel(id) {
    if (!this.child || !this.ready) return;
    const fullId = String(id).includes(":") ? id : this.reqToFull.get(id) || id;
    const windowId = Number(String(fullId).split(":")[0]) || this.windowId;
    const requestId = String(fullId).split(":")[1] || "req";

    this.#send("cancel", { windowId, requestId }, () => {});
    this.reqToFull.delete(requestId);
  }

  // Monotonic message id that wraps safely within the JS safe-integer range.
  #nextId() {
    const id = this.nextMsgId;
    this.nextMsgId = id >= MSG_ID_MAX ? 1 : id + 1;
    return id;
  }

  #send(type, payload, cb) {
    if (!this.child) return;
    const msgId = this.#nextId();
    if (cb) this.pending.set(msgId, { resolve: cb, reject: cb, timer: null });
    try {
      this.child.send({ type, id: msgId, ...payload });
    } catch (err) {
      this.pending.delete(msgId);
      if (cb) cb(err);
      else console.error(`Failed to send "${type}" to engine worker:`, err.message);
    }
  }

  // Reject every in-flight request and every pending ready-waiter with `err`,
  // then reset the bookkeeping maps so a dead worker leaks nothing.
  #failPending(err) {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    this.reqToFull.clear(); // clear memory leak

    for (const r of this.readyResolvers) {
      r.reject(err);
    }
    this.readyResolvers = [];
  }

  #onMessage(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === "ready") {
      this.ready = true;
      this.readyResolvers.forEach((r) => r.resolve());
      this.readyResolvers = [];
      return;
    }

    if (msg.type === "error") {
      const err = new Error(msg.error || "The AI engine failed to start.");
      this.#failPending(err);
      return;
    }

    if (msg.type === "progress") {
      if (this.progressSink)
        this.progressSink(String(msg.id == null ? "" : msg.id), msg.data);
      return;
    }

    if (msg.type === "result") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;

      if (entry.timer) clearTimeout(entry.timer);
      this.pending.delete(msg.id);

      if (entry.requestId) {
        this.reqToFull.delete(entry.requestId); // Clean memory leak
      }

      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || "Unknown engine error."));
    }
  }

  // Gracefully terminate the worker process and clean up on app shutdown.
  shutdown() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* already gone */
      }
      this.child = null;
    }
    this.ready = false;
    this.started = false;
    this.failed = false;
    this.#failPending(
      new Error("The AI engine was shut down. Please restart the app."),
    );
  }
}

module.exports = new EngineHost();
