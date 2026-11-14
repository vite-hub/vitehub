import { checkWebContainerSupport, type WebContainerStage } from "@vite-hub/web-container";
import type { Connect, ConnectProviderName } from "@vite-hub/web-container/connect";
import { type UseWebContainerReturn, useWebContainer } from "@vite-hub/web-container/vue";
import {
  computed,
  defineComponent,
  h,
  markRaw,
  onBeforeUnmount,
  onMounted,
  type PropType,
  reactive,
  ref,
  shallowRef,
  type VNode,
  watch,
} from "vue";
import { useCopy } from "../components/copy-button.ts";
import { Status } from "../components/status.ts";
import { useUIComponent } from "../internal/nuxt-ui.ts";
import { decodePlaygroundLink, encodePlaygroundLink, type PlaygroundFiles, playgroundLinkLimit, playgroundUrl, readPlaygroundHash } from "../playground/share.ts";
import { downloadZip } from "../playground/zip.ts";
import { BrowserSupportNotice } from "./browser-support-notice.ts";
import { ConnectPanel, type ConnectProviderState } from "./connect-panel.ts";
import { useConnectStore } from "./connect-store.ts";
import { WorkspaceBootStatus } from "./workspace-boot-status.ts";
import { WorkspaceEditor } from "./workspace-editor.ts";
import { WorkspaceFileTree } from "./workspace-file-tree.ts";
import { WorkspacePreview, workspacePreviewScript } from "./workspace-preview.ts";
import { type WorkspaceLayout, WorkspaceShell, type WorkspaceTab, type WorkspaceTabItem } from "./workspace-shell.ts";
import { WorkspaceTerminal } from "./workspace-terminal.ts";

/** An app that the container can open. A playground has a menu of them. A tutorial has one, with the files of its step. */
export interface PlaygroundContainerTemplate {
  /** The id in share links and in `update:template`. */
  id: string;
  label: string;
  description?: string;
  files: PlaygroundFiles;
  /** The file that the editor opens first. Defaults to the first file. */
  open?: string;
  /** The path that the preview opens. Defaults to `/`. */
  preview?: string;
  /**
   * Downloads a `node_modules` snapshot for these files, such as `() => fetchSnapshot(parts)`. Without it, the
   * workspace runs `npm install`. Give templates with the same dependencies the same function, so the container
   * switches between them without a new boot.
   */
  snapshot?: () => Promise<Uint8Array | ArrayBuffer>;
}

/** What the slots get, and what `context` gives to code outside the container. */
export interface PlaygroundContext {
  workspace: UseWebContainerReturn;
  /** The template that is open. */
  template: PlaygroundContainerTemplate;
  /** Paths whose contents differ from the files of the open template, sorted. */
  edited: readonly string[];
  /** Opens `path` in the editor. */
  show: (path: string) => void;
  /** Shows a tab, such as `"terminal"`. */
  showTab: (tab: WorkspaceTab) => void;
  /** Runs `action` at once when nothing is edited. Otherwise it asks the reader first, with `confirm` on the button. */
  guard: (title: string, confirm: string, action: () => void) => void;
}

/** Where the page runs: `pending` before mount, then by the viewport width. */
export type PlaygroundDevice = "pending" | "phone" | "tablet" | "desktop";

/**
 * The device of the page and the WebContainer support of the browser, known after mount. Desktops are 64rem wide or
 * more, and tablets 48rem. Use it to place the container, as a page with a lesson next to it does.
 */
export function usePlaygroundDevice() {
  const device = ref<PlaygroundDevice>("pending");
  const supported = ref<boolean>();
  let queries: MediaQueryList[] = [];
  const update = () => {
    const [desktop, tablet] = queries;
    device.value = desktop?.matches ? "desktop" : tablet?.matches ? "tablet" : "phone";
  };
  onMounted(() => {
    queries = [window.matchMedia("(min-width: 64rem)"), window.matchMedia("(min-width: 48rem)")];
    for (const query of queries) query.addEventListener("change", update);
    update();
    supported.value = checkWebContainerSupport().supported;
  });
  onBeforeUnmount(() => {
    for (const query of queries) query.removeEventListener("change", update);
  });
  return { device, supported };
}

const stageLabels: Partial<Record<WebContainerStage, string>> = {
  checking: "Checking the browser",
  booting: "Starting WebContainer",
  mounting: "Loading files",
  installing: "Installing dependencies",
  starting: "Starting the dev server",
};

/** One line that says what the workspace does now. */
const statusTones = { busy: "warning", error: "error", ready: "success" } as const;

function runState(workspace: UseWebContainerReturn): { tone: "busy" | "ready" | "error", label: string } {
  const failure = workspace.failure.value;
  if (failure) return { tone: "error", label: failure.kind === "install" ? "Install failed" : failure.kind === "server" ? "The dev server stopped" : "Did not start" };
  if (workspace.status.value === "ready" && workspace.previewUrl.value) return { tone: "ready", label: "Running" };
  return { tone: "busy", label: stageLabels[workspace.status.value as WebContainerStage] ?? "Starting" };
}

function diff(base: PlaygroundFiles, files: Readonly<PlaygroundFiles>): string[] {
  const paths = new Set([...Object.keys(base), ...Object.keys(files)]);
  return [...paths].filter(path => base[path] !== files[path]).sort();
}

function firstFile(template: PlaygroundContainerTemplate, files: Readonly<PlaygroundFiles>): string {
  return template.open !== undefined && files[template.open] !== undefined ? template.open : Object.keys(files).sort()[0] ?? "";
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const zipName = (prefix: string, template: PlaygroundContainerTemplate) => prefix ? `${prefix}-${template.id}` : template.id;

// The shared props of the container and of one boot of it.
const sessionProps = {
  templates: { required: true as const, type: Array as PropType<readonly PlaygroundContainerTemplate[]> },
  layout: { default: "playground", type: String as PropType<WorkspaceLayout> },
  label: { default: "workspace", type: String },
  name: { default: "", type: String },
  port: { default: undefined, type: Number },
  connect: { default: undefined, type: Object as PropType<Connect> },
  tabs: { default: () => [], type: Array as PropType<readonly WorkspaceTabItem[]> },
  share: { default: true, type: Boolean },
  selected: { default: undefined, type: String },
};

/** One boot of the workspace. The container mounts a new one when the files need other dependencies. */
const PlaygroundSession = defineComponent({
  name: "PlaygroundSession",
  props: {
    ...sessionProps,
    /** The template that this boot mounts. */
    template: { required: true, type: Object as PropType<PlaygroundContainerTemplate> },
    /** The files to boot with: the files of the template, or of a share link. */
    files: { required: true, type: Object as PropType<PlaygroundFiles> },
  },
  emits: {
    "update:selected": (path: string) => typeof path === "string",
    change: (template: PlaygroundContainerTemplate) => !!template,
    remount: (template: PlaygroundContainerTemplate) => !!template,
    context: (context: PlaygroundContext) => !!context,
  },
  setup(props, { emit, slots }) {
    const UButton = useUIComponent("UButton");
    const UDropdownMenu = useUIComponent("UDropdownMenu");
    const UModal = useUIComponent("UModal");

    const booted = props.template;
    // A snapshot holds the dependencies of the template. Files with another package.json, such as from a share link,
    // mount it and then install the difference.
    const sameManifest = props.files["package.json"] === booted.files["package.json"];
    const store = useConnectStore();
    const workspace = useWebContainer({
      files: props.files,
      port: props.port,
      // The browser frame of the preview reads the page address and goes Back and Forward through this script.
      previewScript: workspacePreviewScript,
      env: props.connect && store.env(props.connect),
      ...booted.snapshot && { snapshot: booted.snapshot, install: sameManifest ? false : "install" },
    });
    // Tokens stay in this tab. They reach the app only as environment variables, so a new token restarts the server.
    watch(() => store.credentials.value, () => {
      if (workspace.container.value && workspace.status.value === "ready") void workspace.restart();
    });
    const states = computed(() => {
      const result: Partial<Record<ConnectProviderName, ConnectProviderState>> = {};
      for (const provider of props.connect?.providers ?? []) {
        if (store.credentials.value[provider.name]) result[provider.name] = { status: "connected" };
      }
      return result;
    });

    const current = shallowRef(booted);
    // The page can give new files for the open template, such as a tutorial for its next step.
    const template = computed(() => props.templates.find(item => item.id === current.value.id) ?? current.value);
    const edited = computed(() => diff(template.value.files, workspace.files.value));
    const paths = computed(() => Object.keys(workspace.files.value).sort());
    const selected = ref(props.selected !== undefined && props.files[props.selected] !== undefined ? props.selected : firstFile(booted, props.files));
    watch(() => props.selected, (path) => { if (path !== undefined) selected.value = path; });
    watch(selected, path => emit("update:selected", path), { immediate: true });
    const previewPath = ref(booted.preview ?? "/");
    const tab = ref<WorkspaceTab>(props.layout === "tutorial" ? "preview" : "terminal");
    const booting = computed(() => workspace.status.value !== "ready" || !!workspace.failure.value || !workspace.previewUrl.value);

    const confirm = ref<{ title: string, label: string, action: () => void }>();
    function guard(title: string, label: string, action: () => void) {
      if (edited.value.length === 0) action();
      else confirm.value = { title, label, action };
    }
    function confirmAction() {
      confirm.value?.action();
      confirm.value = undefined;
    }

    // The installed dependencies still fit when the files of the boot and of the editor keep the manifest of the template.
    const keepsDependencies = (next: PlaygroundContainerTemplate) =>
      sameManifest
      && next.snapshot === booted.snapshot
      && workspace.files.value["package.json"] === template.value.files["package.json"]
      && (next.snapshot !== undefined || next.files["package.json"] === booted.files["package.json"]);

    async function load(next: PlaygroundContainerTemplate) {
      // Another snapshot or another manifest needs a fresh dependency tree, so the container boots again.
      if (!keepsDependencies(next)) return emit("remount", next);
      current.value = next;
      selected.value = firstFile(next, next.files);
      previewPath.value = next.preview ?? "/";
      emit("change", next);
      // A failed write is in the terminal. The files on disk are not the template's, so the server does not start again.
      try { await workspace.setFiles(next.files, { mode: "replace" }); }
      catch { return; }
      // The Vite config can differ, so the dev server starts again.
      await workspace.restart();
    }
    function pick(next: PlaygroundContainerTemplate) {
      if (next.id === template.value.id && edited.value.length === 0) return;
      guard(`Open the ${next.label} template?`, "Replace files", () => void load(next));
    }
    function discard() {
      const title = props.templates.length > 1 ? `Discard your changes to the ${template.value.label} template?` : "Discard your changes?";
      guard(title, "Discard changes", () => void load(template.value));
    }

    // Copy link writes the share link. A link that chat apps would cut says so, in place of a toast.
    const { copy, copied } = useCopy();
    const problem = ref<string>();
    async function copyLink() {
      problem.value = undefined;
      const code = await encodePlaygroundLink({ template: template.value.id, files: workspace.files.value }, template.value.files);
      const url = `${location.origin}${playgroundUrl(location.pathname, code)}`;
      if (url.length > playgroundLinkLimit) {
        problem.value = `This link would have ${(url.length / 1000).toFixed(1)} KB, and a share link can have ${playgroundLinkLimit / 1000} KB. Download the files instead.`;
        return;
      }
      await copy(url);
    }

    const context = reactive({
      workspace: markRaw(workspace),
      template,
      edited,
      show: (path: string) => { selected.value = path; },
      showTab: (next: WorkspaceTab) => { tab.value = next; },
      guard,
    });
    emit("context", context);

    const source = computed({
      get: () => workspace.files.value[selected.value] ?? "",
      // A failed write is in the terminal, and the next edit writes the file again.
      set: value => void workspace.setFiles({ [selected.value]: value }).catch(() => {}),
    });

    const hasConnect = computed(() => (props.connect?.providers.length ?? 0) > 0);
    const tabItems = computed<WorkspaceTabItem[]>(() => {
      const connected = Object.keys(states.value).length;
      return [
        ...props.layout === "tutorial" ? [{ label: "Preview", value: "preview" }] : [],
        { label: "Console", value: "terminal" },
        ...hasConnect.value ? [{ badge: connected || undefined, label: "Connect", value: "connect" }] : [],
        ...props.tabs,
      ];
    });

    function toolbar(): VNode {
      const state = runState(workspace);
      const templateMenu = props.templates.length > 1
        ? h(UDropdownMenu, {
            content: { align: "start" },
            items: [
              [{ label: "Templates", type: "label" }],
              props.templates.map(item => ({
                description: item.description,
                icon: item.id === template.value.id ? "i-lucide-check" : "i-lucide-box",
                label: item.label,
                onSelect: () => pick(item),
              })),
            ],
            ui: { content: "w-64" },
          }, () => h(UButton, {
            "aria-label": `Template: ${template.value.label}`,
            color: "neutral",
            icon: "i-lucide-layout-template",
            size: "sm",
            trailingIcon: "i-lucide-chevron-down",
            variant: "ghost",
          }, () => [h("span", { class: "vh-pc-muted" }, "Template"), h("span", { class: "vh-pc-strong" }, template.value.label)]))
        : undefined;
      const more = h(UDropdownMenu, {
        content: { align: "end" },
        items: [[
          { disabled: !workspace.container.value, icon: "i-lucide-refresh-cw", label: "Restart dev server", onSelect: () => void workspace.restart() },
          { disabled: edited.value.length === 0, icon: "i-lucide-rotate-ccw", label: "Discard changes", onSelect: discard },
        ]],
      }, () => h(UButton, { "aria-label": "More actions", color: "neutral", icon: "i-lucide-ellipsis", size: "sm", variant: "ghost" }));
      return h("header", { class: "vh-pc-toolbar" }, [
        templateMenu,
        h("span", { class: "vh-pc-run-state", role: "status" }, h(Status, { colored: state.tone === "error", label: state.label, pulse: state.tone === "busy", tone: statusTones[state.tone] })),
        h("span", { class: "vh-pc-spacer" }),
        slots.toolbar?.(context),
        ...props.share
          ? [
              h(UButton, { color: "neutral", icon: "i-lucide-download", label: "Download", size: "sm", variant: "ghost", onClick: () => downloadZip(workspace.files.value, zipName(props.name, template.value)) }),
              h(UButton, { color: "neutral", icon: copied.value ? "i-lucide-check" : "i-lucide-link", label: copied.value ? "Link copied" : "Copy link", size: "sm", variant: "outline", onClick: () => void copyLink() }),
            ]
          : [],
        more,
      ]);
    }

    function pane(label: string, header: (VNode | undefined)[] | undefined, body: VNode | VNode[], className?: string): VNode {
      return h("section", { "aria-label": label, class: ["vh-pc-pane", className] }, [
        header ? h("div", { class: "vh-pc-pane-header" }, header) : undefined,
        h("div", { class: "vh-pc-pane-body" }, body),
      ]);
    }

    function preview(): VNode {
      if (!booting.value) return pane("Preview", undefined, h(WorkspacePreview, { path: previewPath.value, url: workspace.previewUrl.value, "onUpdate:path": (path: string) => { previewPath.value = path; } }));
      // The checklist takes the place of the preview, so the reader can edit while the app starts.
      return pane("Preview", props.layout === "playground" ? [h("span", { class: "vh-pc-pane-title" }, "Preview")] : undefined, h("div", { class: "vh-pc-boot" }, h(WorkspaceBootStatus, {
        failure: workspace.failure.value,
        online: workspace.online.value,
        status: workspace.status.value,
        steps: workspace.steps.value,
        onRestart: () => void workspace.restart(),
        onRetry: () => void workspace.boot(),
        "onRetry-install": () => void workspace.install(),
        "onShow-output": () => { tab.value = "terminal"; },
      })));
    }

    return () => {
      const connect = props.connect;
      const shellSlots: Record<string, () => VNode | VNode[] | undefined> = {
        files: () => pane("Files", [h("span", { class: "vh-pc-pane-title" }, "Files")], h("div", { class: "vh-pc-tree" }, h(WorkspaceFileTree, {
          modified: edited.value,
          paths: paths.value,
          selected: selected.value,
          "onUpdate:selected": (path: string) => { selected.value = path; },
        })), "vh-pc-files"),
        editor: () => pane("Editor", [
          h("span", { class: "vh-pc-path" }, selected.value),
          edited.value.includes(selected.value) ? h("span", { class: "vh-pc-muted" }, "Edited") : undefined,
        ], h(WorkspaceEditor, { modelValue: source.value, path: selected.value, "onUpdate:modelValue": (value: string) => { source.value = value; } })),
        preview,
        terminal: () => h(WorkspaceTerminal, { output: workspace.logs.value }),
        ...connect && hasConnect.value && {
          connect: () => h("div", { class: "vh-pc-scroll" }, h(ConnectPanel, {
            connect,
            states: states.value,
            onConnect: (name: ConnectProviderName, token: string) => store.set(name, token),
            onDisconnect: (name: ConnectProviderName) => store.remove(name),
            "onRemove-all": () => store.clear(),
            "onCopy-command": (command: string) => void copy(command),
          })),
        },
        ...Object.fromEntries(props.tabs.map(item => [item.value, () => slots[item.value]?.(context)])),
      };
      return h("div", { class: "vh-pc-session" }, [
        toolbar(),
        problem.value ? h("div", { class: "vh-pc-bar", role: "status" }, problem.value) : undefined,
        slots.banner?.(context),
        h(WorkspaceShell, {
          label: capitalize(props.label),
          layout: props.layout,
          storageKey: `vitehub:playground-container:${props.layout}`,
          tab: tab.value,
          tabs: tabItems.value,
          "onUpdate:tab": (next: WorkspaceTab) => { tab.value = next; },
        }, shellSlots),
        h(UModal, {
          description: props.share
            ? "Your edits to the current files are lost. Copy a link or download them first to keep them."
            : "Your edits to the current files are lost.",
          open: !!confirm.value,
          title: confirm.value?.title,
          "onUpdate:open": (open: boolean) => { if (!open) confirm.value = undefined; },
        }, {
          footer: () => h("div", { class: "vh-pc-modal-actions" }, [
            h(UButton, { color: "neutral", label: "Cancel", variant: "ghost", onClick: () => { confirm.value = undefined; } }),
            h(UButton, { color: "neutral", label: confirm.value?.label, onClick: confirmAction }),
          ]),
        }),
      ]);
    };
  },
});

/**
 * A complete browser playground: the toolbar, file tree, editor, preview, and dev server console of an app that runs
 * in a WebContainer. It tracks edits, restarts the dev server, asks before it discards edits, copies share links,
 * downloads zips, and shows the workspace only on devices that can run it.
 */
export const PlaygroundContainer = defineComponent({
  name: "PlaygroundContainer",
  props: {
    /** The apps to open. More than one shows a template menu. */
    templates: sessionProps.templates,
    /** The id of the template to open first, such as from `?template=`. Defaults to the first template. */
    template: { default: undefined, type: String },
    /** `playground` puts the preview at the side. `tutorial` puts it in a tab under the editor. */
    layout: sessionProps.layout,
    /** What the reader calls this, in lowercase, such as `"playground"`. It names the Open button and the notices. */
    label: sessionProps.label,
    /** The start of the zip name. The template id follows it, as in `vitehub-kv.zip`. */
    name: sessionProps.name,
    /** The port of the dev server, such as `3000` for `vite --port 3000`. Other servers do not become the preview. */
    port: sessionProps.port,
    /** The providers of `defineConnect()`. Their tokens reach the dev server as environment variables. */
    connect: sessionProps.connect,
    /** More tabs next to Console and Connect. Each one shows the slot with the name of its `value`. */
    tabs: sessionProps.tabs,
    /** Copy link and Download in the toolbar, and opening `#code=` links. */
    share: sessionProps.share,
    /** The file in the editor. Use `v-model:selected`. */
    selected: sessionProps.selected,
    /** Whether the workspace shows. Desktops show it on their own. Set it to `true` to show it on a tablet. Use `v-model:open`. */
    open: { default: false, type: Boolean },
  },
  emits: {
    /** The reader opened a template, or discarded the changes to one. */
    "update:template": (id: string) => typeof id === "string",
    "update:selected": (path: string) => typeof path === "string",
    "update:open": (open: boolean) => typeof open === "boolean",
    /** A workspace booted. It gives the context that the slots get, for code outside the container. */
    context: (context: PlaygroundContext) => !!context,
  },
  setup(props, { emit, slots }) {
    const UButton = useUIComponent("UButton");
    const { device, supported } = usePlaygroundDevice();
    const first = () => props.templates.find(item => item.id === props.template) ?? props.templates[0]!;

    // `id` changes when the workspace must boot again, such as for a template with other dependencies.
    // Only share links pin files. A deferred boot or download reads the current files of its template.
    const session = shallowRef<{ id: number, template: PlaygroundContainerTemplate, files?: PlaygroundFiles }>();
    const active = computed(() => props.templates.find(item => item.id === session.value?.template.id) ?? session.value?.template ?? first());
    const link = ref<"restored" | "invalid">();
    function boot(template: PlaygroundContainerTemplate, files?: PlaygroundFiles) {
      session.value = { files, id: (session.value?.id ?? 0) + 1, template };
    }

    let restoration = 0;
    /** A `#code=…` link holds files. They open on their template. */
    async function restore() {
      const request = ++restoration;
      const code = props.share ? readPlaygroundHash(location.hash) : undefined;
      const decoded = code ? await decodePlaygroundLink(code, props.templates) : undefined;
      if (request !== restoration) return;
      const shared = decoded?.template === undefined ? undefined : props.templates.find(item => item.id === decoded.template);
      link.value = shared ? "restored" : code ? "invalid" : undefined;
      if (shared && decoded) return boot(shared, decoded.files);
      boot(first());
    }
    onMounted(() => {
      void restore();
      if (props.share) window.addEventListener("hashchange", restore);
    });
    onBeforeUnmount(() => window.removeEventListener("hashchange", restore));

    function opened(template: PlaygroundContainerTemplate) {
      // The share link no longer matches the files.
      link.value = undefined;
      emit("update:template", template.id);
    }

    const requested = ref(props.open);
    watch(() => props.open, (open) => { requested.value = open; });
    // Only desktops boot the workspace on their own. Tablets boot it on a tap. Phones never boot it.
    const shown = computed(() => !!session.value && supported.value === true && (device.value === "desktop" || (device.value === "tablet" && requested.value)));
    watch(shown, (value) => { if (value !== props.open) emit("update:open", value); });

    const { copy: copyPage, copied } = useCopy({ duration: 1500 });
    function download() {
      downloadZip(session.value?.files ?? active.value.files, zipName(props.name, active.value));
    }
    const downloadButton = () => h(UButton, { color: "neutral", icon: "i-lucide-download", label: "Download files", size: "sm", variant: "outline", onClick: download });

    function linkBar(): VNode | undefined {
      if (!link.value || !session.value) return undefined;
      const label = session.value.template.label;
      const many = props.templates.length > 1;
      return h("div", { class: "vh-pc-bar", role: "status" }, link.value === "invalid"
        ? `This link has no files that the ${props.label} can read.${many ? ` It opened the ${label} template.` : ""}`
        : `You opened shared files${many ? ` on the ${label} template` : ""}.`);
    }

    function gate(): VNode {
      // Before mount the page cannot know the device, so CSS shows the phone card or the placeholder by width.
      const state = device.value === "pending" ? "pending"
        : device.value === "phone" ? "phone"
          : supported.value === false ? "unsupported"
            : device.value === "tablet" ? "tablet"
              : "pending";
      const phone = h("aside", { class: "vh-pc-card vh-pc-phone" }, [
        h("p", { class: "vh-pc-strong" }, `The live ${props.label} runs in a desktop browser. Open this page on a desktop to edit and run the code.`),
        h("div", { class: "vh-pc-actions" }, [
          h(UButton, { color: "neutral", icon: copied.value ? "i-lucide-check" : "i-lucide-link", label: copied.value ? "Copied" : "Copy link", size: "sm", variant: "outline", onClick: () => void copyPage(location.href) }),
          downloadButton(),
        ]),
      ]);
      const card = state === "pending" || state === "phone"
        ? phone
        : state === "unsupported"
          ? h("div", { class: "vh-pc-unsupported" }, [
              h(BrowserSupportNotice, {
                description: "Download the files to run the app on your machine, or open this page in Chrome, Edge, or Firefox on a desktop to edit and run it here.",
                supported: false,
              }),
              h("div", { class: "vh-pc-actions" }, [downloadButton()]),
            ])
          : h("div", { class: "vh-pc-card" }, [
              h("p", { class: "vh-pc-muted" }, "Edit and run the code in your browser. The first start downloads the dependencies of the app."),
              h("div", { class: "vh-pc-actions" }, [
                h(UButton, { color: "neutral", icon: "i-lucide-play", label: `Open ${props.label}`, onClick: () => { requested.value = true; } }),
              ]),
            ]);
      return h("div", { class: "vh-pc-gate", "data-state": state }, [
        state === "pending"
          ? h("div", { class: "vh-pc-placeholder" }, [h("div", { class: "vh-pc-placeholder-bar" }), h("p", { class: "vh-pc-muted" }, `Starting the ${props.label}`)])
          : undefined,
        h("div", { class: "vh-pc-gate-content" }, [slots.intro?.(), card, slots.fallback?.()]),
      ]);
    }

    return () => {
      const current = session.value;
      return h("div", { class: "vh-pc", "data-layout": props.layout }, [
        linkBar(),
        shown.value && current
          ? h(PlaygroundSession, {
              key: current.id,
              connect: props.connect,
              files: current.files ?? active.value.files,
              label: props.label,
              layout: props.layout,
              name: props.name,
              port: props.port,
              selected: props.selected,
              share: props.share,
              tabs: props.tabs,
              template: active.value,
              templates: props.templates,
              onChange: opened,
              onContext: (context: PlaygroundContext) => emit("context", context),
              onRemount: (template: PlaygroundContainerTemplate) => {
                opened(template);
                boot(template);
              },
              "onUpdate:selected": (path: string) => emit("update:selected", path),
            }, slots)
          : gate(),
      ]);
    };
  },
});
