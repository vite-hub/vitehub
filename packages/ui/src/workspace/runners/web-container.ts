import { checkWebContainerSupport, type WebContainerStage } from "@vite-hub/web-container";
import type { Connect, ConnectProviderName } from "@vite-hub/web-container/connect";
import { type UseWebContainerReturn, useWebContainer } from "@vite-hub/web-container/vue";
import { computed, getCurrentInstance, h, onMounted, onScopeDispose, ref, shallowRef, type ShallowRef, watch } from "vue";
import { useCopy } from "../../components/copy-button.ts";
import { ConnectPanel, type ConnectProviderState } from "../connect-panel.ts";
import { useConnectStore } from "../connect-store.ts";
import { WorkspaceBootStatus } from "../workspace-boot-status.ts";
import type { WorkspaceExample } from "../workspace-examples.ts";
import { WorkspacePreview, workspacePreviewScript } from "../workspace-preview.ts";
import type { WorkspaceTabItem } from "../workspace-shell.ts";
import { WorkspaceTerminal } from "../workspace-terminal.ts";
import type { WorkspaceMenuItem, WorkspaceRun, WorkspaceRunner, WorkspaceRunState } from "../workspace.ts";

/** Loads a `node_modules` snapshot, such as `() => fetchSnapshot(parts)`. */
export type WorkspaceSnapshot = () => Promise<Uint8Array | ArrayBuffer>;

export interface WebContainerRunnerOptions {
  /** The port of the dev server, such as `3000` for `vite --port 3000`. Other servers do not become the preview. */
  port?: number;
  /**
   * The `node_modules` snapshot of an example. Without one, the runner runs `npm install`. Give examples with the same
   * dependencies the same function, so the runner opens them without a new boot.
   */
  snapshot?: (example: WorkspaceExample) => WorkspaceSnapshot | undefined;
  /** The providers of `defineConnect()`. Their tokens reach the dev server as environment variables. */
  connect?: Connect;
}

/** The runner of `webContainer()`. `workspace` is the WebContainer of the current run, for code outside the workspace. */
export interface WebContainerRunner extends WorkspaceRunner {
  readonly workspace: Readonly<ShallowRef<UseWebContainerReturn | undefined>>;
}

const stageLabels: Partial<Record<WebContainerStage, string>> = {
  checking: "Checking the browser",
  booting: "Starting WebContainer",
  mounting: "Loading files",
  installing: "Installing dependencies",
  starting: "Starting the dev server",
};

function runState(workspace: UseWebContainerReturn): WorkspaceRunState {
  const failure = workspace.failure.value;
  if (failure) return { tone: "error", label: failure.kind === "install" ? "Install failed" : failure.kind === "server" ? "The dev server stopped" : "Did not start" };
  if (workspace.status.value === "ready" && workspace.previewUrl.value) return { tone: "ready", label: "Running" };
  return { tone: "busy", label: stageLabels[workspace.status.value as WebContainerStage] ?? "Starting" };
}

/**
 * Runs the files of a `Workspace` as an app in a WebContainer, with a dev server, a Preview tab, a Terminal tab, and a
 * Connect tab for `connect`. Only desktops start it on their own.
 */
export function webContainer(options: WebContainerRunnerOptions = {}): WebContainerRunner {
  const current = shallowRef<UseWebContainerReturn>();
  let queue: Promise<void> = Promise.resolve();

  function start({ example: booted, files, showTab }: Parameters<WorkspaceRunner["start"]>[0]): WorkspaceRun {
    const snapshot = options.snapshot?.(booted);
    const bootManifest = booted.files?.["package.json"];
    const sameManifest = files["package.json"] === bootManifest;
    const store = useConnectStore();
    const { copy } = useCopy();
    const workspace = useWebContainer({
      files,
      immediate: false,
      port: options.port,
      previewScript: workspacePreviewScript,
      env: options.connect && store.env(options.connect),
      ...snapshot && { snapshot, install: sameManifest ? false : "install" },
    });
    current.value = workspace;

    let disposed = false;
    let release!: () => void;
    const turn = queue;
    queue = new Promise<void>((resolve) => { release = resolve; });
    const boots = new Set<Promise<void>>();
    function inTurn(action: () => Promise<void>): Promise<void> {
      return turn.then(() => {
        if (disposed) return;
        if (workspace.container.value) return action();
        const boot = workspace.boot();
        boots.add(boot);
        const done = () => { boots.delete(boot); };
        boot.then(done, done);
        return boot;
      });
    }
    let booting: Promise<void> | undefined;
    const ownTurn = () => {
      booting ??= inTurn(() => workspace.boot());
      return booting;
    };
    const restart = () => inTurn(() => workspace.restart());
    if (getCurrentInstance()) onMounted(ownTurn);
    else void ownTurn();
    onScopeDispose(() => {
      disposed = true;
      workspace.teardown();
      if (current.value === workspace) current.value = undefined;
      void Promise.allSettled([turn, ...boots]).then(release);
    });

    watch(() => store.credentials.value, () => {
      if (workspace.container.value && workspace.status.value === "ready") void restart();
    });
    const states = computed(() => {
      const result: Partial<Record<ConnectProviderName, ConnectProviderState>> = {};
      for (const provider of options.connect?.providers ?? []) {
        if (store.credentials.value[provider.name]) result[provider.name] = { status: "connected" };
      }
      return result;
    });

    let opened = booted;
    const previewPath = ref(booted.preview ?? "/");
    const starting = computed(() => workspace.status.value !== "ready" || !!workspace.failure.value || !workspace.previewUrl.value);

    const tabs = computed<WorkspaceTabItem[]>(() => {
      const connected = Object.keys(states.value).length;
      return [
        { label: "Preview", value: "preview" },
        { label: "Terminal", value: "terminal" },
        ...options.connect?.providers.length ? [{ badge: connected || undefined, label: "Connect", value: "connect" }] : [],
      ];
    });
    const actions = computed<WorkspaceMenuItem[]>(() => [
      { disabled: !workspace.container.value, icon: "i-lucide-refresh-cw", label: "Restart dev server", onSelect: () => void restart() },
    ]);

    return {
      files: workspace.files,
      setFiles: (next, setOptions) => workspace.setFiles(next, setOptions),
      keeps: next => sameManifest
        && options.snapshot?.(next) === snapshot
        && workspace.files.value["package.json"] === opened.files?.["package.json"]
        && (snapshot !== undefined || next.files?.["package.json"] === bootManifest),
      async open(next, nextFiles) {
        opened = next;
        previewPath.value = next.preview ?? "/";
        try { await workspace.setFiles(nextFiles, { mode: "replace" }); }
        catch { return; }
        if (workspace.container.value) await restart();
      },
      tabs,
      panel(tab) {
        if (tab === "preview") {
          if (!starting.value) return h(WorkspacePreview, { path: previewPath.value, url: workspace.previewUrl.value, "onUpdate:path": (path: string) => { previewPath.value = path; } });
          return h("div", { class: "vh-workspace-boot" }, h(WorkspaceBootStatus, {
            failure: workspace.failure.value,
            online: workspace.online.value,
            status: workspace.status.value,
            steps: workspace.steps.value,
            onRestart: () => void restart(),
            onRetry: () => void inTurn(() => workspace.boot()),
            "onRetry-install": () => void inTurn(() => workspace.install()),
            "onShow-output": () => showTab("terminal"),
          }));
        }
        if (tab === "terminal") return h(WorkspaceTerminal, { output: workspace.logs.value });
        const connect = options.connect;
        if (tab === "connect" && connect) {
          return h("div", { class: "vh-workspace-scroll" }, h(ConnectPanel, {
            connect,
            states: states.value,
            onConnect: (name: ConnectProviderName, token: string) => store.set(name, token),
            onDisconnect: (name: ConnectProviderName) => store.remove(name),
            "onRemove-all": () => store.clear(),
            "onCopy-command": (command: string) => void copy(command),
          }));
        }
        return undefined;
      },
      state: computed(() => runState(workspace)),
      actions,
    };
  }

  return {
    desktop: true,
    start,
    supported: () => checkWebContainerSupport().supported,
    workspace: current,
  };
}
