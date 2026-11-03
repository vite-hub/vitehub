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
  | { kind: "install", error: Error, exitCode: number }
  | { kind: "server", error: Error, exitCode: number };

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
  /** The port that the dev server listens on, such as `3000` for `vite --port 3000`. Other servers do not become the preview. */
  port?: number;
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
  /** Terminal output chunks of every process, in order. The array is replaced when new output comes. */
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

  // Output comes in many small chunks during an install. Batch them so the array is copied once per frame, not once per chunk.
  let pendingLogs: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  function appendLog(chunk: string) {
    pendingLogs.push(chunk);
    flushTimer ??= setTimeout(() => {
      flushTimer = undefined;
      logs.value = [...logs.value, ...pendingLogs];
      pendingLogs = [];
    }, 32);
  }

  // What the container has on disk. Edits made before mount differ from it and are written when mount ends.
  let written: WorkspaceFiles = {};
  let writes: Promise<void> = Promise.resolve();
  let booting: Promise<void> | undefined;
  let devRun: WebContainerRun | undefined;
  let stopping = false;
  let disposed = false;

  function sync(): Promise<void> {
    writes = writes.then(async () => {
      const target = fs.value;
      if (!target) return;
      const current = files.value;
      for (const path of Object.keys(written)) {
        if (path in current) continue;
        await target.rm(path, { force: true });
        delete written[path];
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

  async function startServer(target: ViteHubWebContainer) {
    if (startCommand === false) return;
    const run = await target.run(startCommand, { env: env() });
    devRun = run;
    pipe(run);
    void run.exit.then((exitCode) => {
      if (devRun !== run) return;
      devRun = undefined;
      if (stopping || disposed) return;
      previewUrl.value = undefined;
      failure.value = { kind: "server", exitCode, error: new Error(`The dev server exited with code ${exitCode}.`) };
      status.value = "error";
    });
    // `ready` rejects when the server fails before it is ready. The exit handler above reports that.
    target.preview.ready.then((server) => {
      if (devRun === run) previewUrl.value = server.url;
    }, () => {});
  }

  async function installAndStart(target: ViteHubWebContainer) {
    failure.value = undefined;
    if (installCommand !== false) {
      const run = await target.run(installCommand, { env: env() });
      pipe(run);
      const exitCode = await run.exit;
      if (exitCode !== 0) {
        failure.value = { kind: "install", exitCode, error: target.status.error ?? new Error(`npm install exited with code ${exitCode}.`) };
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
          port: options.port,
          onStatus(next) {
            status.value = next.stage;
            steps.value = next.steps;
          },
        });
        if (disposed) return target.teardown();
        container.value = target;
        fs.value = target.fs;
        // The `server-ready` event moves a restarted server to `ready` only from `starting`. Track the URL here too.
        target.on("status", (next) => {
          if (next.stage === "ready" && target.preview.url) previewUrl.value = target.preview.url;
        });
        await sync();
        await installAndStart(target);
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
    if (!run) return;
    stopping = true;
    run.kill();
    await run.exit.catch(() => {});
    stopping = false;
    previewUrl.value = undefined;
  }

  async function install() {
    const target = container.value;
    if (!target) return boot();
    await stopServer();
    await installAndStart(target);
  }

  async function restart() {
    const target = container.value;
    if (!target) return boot();
    failure.value = undefined;
    await stopServer();
    await startServer(target);
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
