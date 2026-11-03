import {
  bootWebContainer,
  checkWebContainerSupport,
  type FileSystemAPI,
  type ViteHubWebContainer,
  type WebContainerCommand,
  type WebContainerRun,
  type WebContainerStage,
  type WebContainerStep,
  type WebContainerSupport,
} from "@vite-hub/web-container";
import {
  computed,
  type ComputedRef,
  getCurrentInstance,
  getCurrentScope,
  type MaybeRefOrGetter,
  onMounted,
  onScopeDispose,
  type Ref,
  readonly,
  ref,
  type ShallowRef,
  shallowRef,
  toValue,
} from "vue";

/** Text files of the app, keyed by a relative path such as `server/routes/index.ts`. */
export type WorkspaceFiles = Record<string, string>;

/** `idle` comes before the first `boot()`. The other stages come from `@vite-hub/web-container`. */
export type WorkspaceStatus = "idle" | WebContainerStage;

/** Why the workspace stopped. The UI picks its copy and its recovery action from `kind`. */
export type WorkspaceFailure =
  | { kind: "unsupported", error: Error }
  | { kind: "boot", error: Error }
  | { kind: "install", error: Error, exitCode?: number }
  | { kind: "server", error: Error, exitCode?: number };

export interface UseWorkspaceOptions {
  /** The files to mount. `reset()` goes back to them. */
  files: WorkspaceFiles;
  /** A snapshot from `container.export()`, mounted before `files`. Use it to skip a cold install. */
  snapshot?: Uint8Array | ArrayBuffer;
  /**
   * The install command. `false` skips the install, for example when the snapshot has `node_modules`.
   * @default "install"
   */
  install?: WebContainerCommand | false;
  /**
   * The command that starts the dev server. `false` boots and installs only.
   * @default "dev"
   */
  start?: WebContainerCommand | false;
  /** Environment variables for the install and start processes, such as `connectEnv(connect, credentials)`. Read again on each run. */
  env?: MaybeRefOrGetter<Record<string, string> | undefined>;
  /**
   * Boot when the calling component mounts. Set `false` to boot on a click with `boot()`.
   * @default true
   */
  immediate?: boolean;
}

export interface SetFilesOptions {
  /** `merge` writes the given files and keeps the others. `replace` also removes files that are not given. */
  mode?: "merge" | "replace";
}

export interface Workspace {
  status: Readonly<Ref<WorkspaceStatus>>;
  /** Every stage so far, with its timing. */
  steps: Readonly<ShallowRef<readonly WebContainerStep[]>>;
  /** Set after the first support check, on the client only. */
  support: Readonly<ShallowRef<WebContainerSupport | undefined>>;
  failure: Readonly<ShallowRef<WorkspaceFailure | undefined>>;
  error: ComputedRef<Error | undefined>;
  /** The current files, including edits. */
  files: Readonly<ShallowRef<Readonly<WorkspaceFiles>>>;
  /** Paths whose contents differ from `options.files`, sorted. */
  modified: ComputedRef<readonly string[]>;
  /** The WebContainer file system, after mount. */
  fs: Readonly<ShallowRef<FileSystemAPI | undefined>>;
  container: Readonly<ShallowRef<ViteHubWebContainer | undefined>>;
  previewUrl: Readonly<Ref<string | undefined>>;
  /** Recent output in order, limited to 65,536 characters and 1,000 chunks. The array is replaced when new output comes. */
  logs: Readonly<ShallowRef<readonly string[]>>;
  /** `navigator.onLine`. An offline reader keeps their edits, but install needs a connection. */
  online: Readonly<Ref<boolean>>;
  boot: () => Promise<void>;
  /** Runs the install again, then starts the dev server. */
  install: () => Promise<void>;
  /** Stops the dev server, if it runs, and starts it again. */
  restart: () => Promise<void>;
  setFiles: (files: WorkspaceFiles, options?: SetFilesOptions) => Promise<void>;
  /** Puts back the original files. */
  reset: () => Promise<void>;
  teardown: () => void;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function parentDirectory(path: string): string | undefined {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : undefined;
}

/**
 * Runs an app in a WebContainer and keeps the state that the workspace components render.
 *
 * This is the only `@vite-hub/ui` module that imports `@vite-hub/web-container`. Only one WebContainer runs per page.
 */
export function useWorkspace(options: UseWorkspaceOptions): Workspace {
  const initial: WorkspaceFiles = { ...options.files };
  const installCommand = options.install ?? "install";
  const startCommand = options.start ?? "dev";

  const status = ref<WorkspaceStatus>("idle");
  const steps = shallowRef<readonly WebContainerStep[]>([]);
  const support = shallowRef<WebContainerSupport>();
  const failure = shallowRef<WorkspaceFailure>();
  const files = shallowRef<Readonly<WorkspaceFiles>>({ ...initial });
  const fs = shallowRef<FileSystemAPI>();
  const container = shallowRef<ViteHubWebContainer>();
  const previewUrl = ref<string>();
  const logs = shallowRef<readonly string[]>([]);
  const online = ref(typeof navigator === "undefined" ? true : navigator.onLine);

  const modified = computed(() => {
    const current = files.value;
    const paths = new Set([...Object.keys(initial), ...Object.keys(current)]);
    return [...paths].filter(path => initial[path] !== current[path]).sort();
  });

  // Bound the buffer before batching, including output that arrives between flushes.
  const logLimit = 64 * 1024;
  const logChunkLimit = 1000;
  const retainedLogs: string[] = [];
  let retainedLength = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  function appendLog(chunk: string) {
    if (disposed || !chunk) return;
    const tail = chunk.slice(-logLimit);
    retainedLogs.push(tail);
    retainedLength += tail.length;
    while (retainedLogs.length > logChunkLimit || retainedLength > logLimit) {
      const first = retainedLogs[0]!;
      const excess = retainedLength - logLimit;
      if (retainedLogs.length > logChunkLimit || first.length <= excess) {
        retainedLogs.shift();
        retainedLength -= first.length;
      }
      else {
        retainedLogs[0] = first.slice(excess);
        retainedLength -= excess;
      }
    }
    // Copy once per flush rather than once per process chunk.
    flushTimer ??= setTimeout(() => {
      flushTimer = undefined;
      logs.value = [...retainedLogs];
    }, 32);
  }

  // What the container has on disk. Edits made before mount differ from it and are written when mount ends.
  let written: WorkspaceFiles = {};
  let writes: Promise<void> = Promise.resolve();
  let booting: Promise<void> | undefined;
  let devRun: WebContainerRun | undefined;
  let serverActive = false;
  let recovery = Promise.resolve();
  let disposed = false;

  function sync(): Promise<void> {
    writes = writes.then(async () => {
      const target = fs.value;
      if (!target) return;
      const current = files.value;
      const conflictingDirectories = new Set<string>();
      for (const path of Object.keys(written)) {
        if (path in current) continue;
        await target.rm(path, { force: true });
        delete written[path];
        let directory = parentDirectory(path);
        while (directory) {
          if (Object.keys(current).some(file => directory === file || directory?.startsWith(`${file}/`))) conflictingDirectories.add(directory);
          directory = parentDirectory(directory);
        }
      }
      // Remove empty owned directories from the leaves up before replacing them with a file.
      for (const directory of [...conflictingDirectories].sort((a, b) => b.length - a.length)) {
        await target.rm(directory, { force: true });
      }
      for (const [path, contents] of Object.entries(current)) {
        if (written[path] === contents) continue;
        const directory = parentDirectory(path);
        if (directory) await target.mkdir(directory, { recursive: true });
        await target.writeFile(path, contents);
        written[path] = contents;
      }
    }).catch((cause) => {
      appendLog(`\r\nCould not write the files: ${toError(cause).message}\r\n`);
    });
    return writes;
  }

  function pipe(run: WebContainerRun) {
    void run.output.pipeTo(new WritableStream({ write: appendLog })).catch(() => {});
  }

  function env() {
    const value = toValue(options.env);
    return value && Object.keys(value).length > 0 ? { ...value } : undefined;
  }

  function enter(stage: WebContainerStage) {
    const now = performance.now();
    const previous = steps.value.map(step => step.ms === undefined ? { ...step, ms: now - step.startedAt } : step);
    status.value = stage;
    steps.value = [...previous, { stage, startedAt: now, ...(stage === "ready" ? { ms: 0 } : {}) }];
  }

  async function startServer(target: ViteHubWebContainer) {
    if (disposed) return;
    if (startCommand === false) {
      enter("ready");
      return;
    }
    serverActive = true;
    enter("starting");
    try {
      const run = await target.run(startCommand, { env: env() });
      if (disposed) {
        run.kill();
        return;
      }
      devRun = run;
      pipe(run);
      void run.exit.then((exitCode) => {
        if (devRun !== run) return;
        devRun = undefined;
        serverActive = false;
        if (disposed) return;
        previewUrl.value = undefined;
        failure.value = { kind: "server", exitCode, error: new Error(`The dev server exited with code ${exitCode}.`) };
        status.value = "error";
      });
    }
    catch (cause) {
      serverActive = false;
      failure.value = { kind: "server", error: toError(cause) };
      status.value = "error";
    }
  }

  async function installAndStart(target: ViteHubWebContainer) {
    failure.value = undefined;
    if (installCommand !== false) {
      enter("installing");
      try {
        const run = await target.run(installCommand, { env: env() });
        pipe(run);
        const exitCode = await run.exit;
        if (disposed) return;
        if (exitCode !== 0) {
          failure.value = { kind: "install", exitCode, error: target.status.error ?? new Error(`npm install exited with code ${exitCode}.`) };
          status.value = "error";
          return;
        }
        if (failure.value) return;
      }
      catch (cause) {
        failure.value = { kind: "install", error: toError(cause) };
        status.value = "error";
        return;
      }
    }
    await startServer(target);
  }

  function boot(): Promise<void> {
    if (booting) return booting;
    if (container.value) return Promise.resolve();
    failure.value = undefined;
    steps.value = [];
    booting = (async () => {
      written = { ...files.value };
      try {
        const target = await bootWebContainer({
          files: written,
          snapshot: options.snapshot,
          onStatus(next) {
            if (disposed) return;
            if (next.stage === "error") {
              failure.value ??= {
                kind: status.value === "installing" ? "install" : container.value ? "server" : "boot",
                error: next.error ?? new Error("The workspace stopped unexpectedly."),
              };
              previewUrl.value = undefined;
            }
            // Only an explicit recovery action clears a failure, not a late status update.
            status.value = failure.value ? "error" : next.stage;
            steps.value = next.steps;
          },
        });
        if (disposed) return target.teardown();
        container.value = target;
        fs.value = target.fs;
        target.on("server-ready", (server) => {
          if (!serverActive || disposed || failure.value) return;
          previewUrl.value = server.url;
          enter("ready");
        });
        await sync();
        if (!failure.value) await installAndStart(target);
      }
      catch (cause) {
        const error = toError(cause);
        failure.value = error.name === "WebContainerUnsupportedError" ? { kind: "unsupported", error } : { kind: "boot", error };
        status.value = failure.value.kind === "unsupported" ? "unsupported" : "error";
      }
      finally {
        booting = undefined;
      }
    })();
    return booting;
  }

  async function stopServer() {
    const run = devRun;
    devRun = undefined;
    serverActive = false;
    previewUrl.value = undefined;
    if (!run) return;
    run.kill();
    await run.exit.catch(() => {});
  }

  function recover(action: (target: ViteHubWebContainer) => Promise<void>) {
    const pending = recovery.then(async () => {
      if (booting) await booting;
      if (disposed) return;
      const target = container.value;
      if (!target) return boot();
      await stopServer();
      if (!disposed) {
        failure.value = undefined;
        await action(target);
      }
    });
    recovery = pending.catch(() => {});
    return pending;
  }

  function install() {
    return recover(installAndStart);
  }

  function restart() {
    return recover(startServer);
  }

  async function setFiles(next: WorkspaceFiles, setOptions: SetFilesOptions = {}) {
    files.value = setOptions.mode === "replace" ? { ...next } : { ...files.value, ...next };
    await sync();
  }

  function teardown() {
    disposed = true;
    if (flushTimer) clearTimeout(flushTimer);
    devRun = undefined;
    container.value?.teardown();
    container.value = undefined;
    fs.value = undefined;
  }

  if (typeof window !== "undefined") {
    const update = () => { online.value = navigator.onLine; };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    if (getCurrentScope()) {
      onScopeDispose(() => {
        window.removeEventListener("online", update);
        window.removeEventListener("offline", update);
      });
    }
  }
  if (getCurrentScope()) onScopeDispose(teardown);

  const start = () => {
    support.value = checkWebContainerSupport();
    if (options.immediate !== false) void boot();
  };
  if (getCurrentInstance()) onMounted(start);
  else if (typeof window !== "undefined") start();

  return {
    status: readonly(status),
    steps,
    support,
    failure,
    error: computed(() => failure.value?.error),
    files,
    modified,
    fs,
    container,
    previewUrl: readonly(previewUrl),
    logs,
    online: readonly(online),
    boot,
    install,
    restart,
    setFiles,
    reset: () => setFiles(initial, { mode: "replace" }),
    teardown,
  };
}
