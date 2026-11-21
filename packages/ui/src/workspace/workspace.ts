import {
  computed,
  type ComputedRef,
  defineComponent,
  type ExtractPropTypes,
  h,
  inject,
  type InjectionKey,
  markRaw,
  onBeforeUnmount,
  onMounted,
  type PropType,
  provide,
  reactive,
  type Ref,
  ref,
  shallowRef,
  type VNode,
  watch,
} from "vue";
import { useCopy } from "../components/copy-button.ts";
import { Status } from "../components/status.ts";
import { uiErrorDiagnostics } from "../error-diagnostics.ts";
import { useUIComponent } from "../internal/nuxt-ui.ts";
import { ring } from "../motion/helpers/ring.ts";
import { decodePlaygroundLink, encodePlaygroundLink, playgroundLinkLimit, playgroundUrl, readPlaygroundHash } from "../playground/share.ts";
import { downloadZip } from "../playground/zip.ts";
import { BrowserSupportNotice } from "./browser-support-notice.ts";
import { WorkspaceBar } from "./workspace-bar.ts";
import { WorkspaceEditor } from "./workspace-editor.ts";
import { WorkspaceEditorHead } from "./workspace-editor-head.ts";
import { type WorkspaceExample, WorkspaceExamples } from "./workspace-examples.ts";
import { provideWorkspaceFileOpener } from "./workspace-file-link.ts";
import { WorkspaceFileTree } from "./workspace-file-tree.ts";
import { WorkspaceGuide } from "./workspace-guide.ts";
import { type WorkspaceLayout, WorkspaceShell, type WorkspaceTab, type WorkspaceTabItem } from "./workspace-shell.ts";
import { WorkspaceSidebar, type WorkspaceSidebarAction } from "./workspace-sidebar.ts";
import { WorkspaceStart } from "./workspace-start.ts";
import { type WorkspaceCursor, WorkspaceStatus } from "./workspace-status.ts";
import { type WorkspaceStep, WorkspaceSteps } from "./workspace-steps.ts";

/** Files by project-relative path. */
export type WorkspaceFiles = Record<string, string>;

/** The line in the bar that says what the run does now. */
export interface WorkspaceRunState {
  tone: "busy" | "ready" | "error";
  label: string;
}

/** An item of the More menu of the bar, such as "Restart dev server". */
export interface WorkspaceMenuItem {
  label: string;
  icon?: string;
  disabled?: boolean;
  onSelect: () => void;
}

/** What a runner gets when the workspace starts it. */
export interface WorkspaceRunInput {
  /** The example that this run starts with. */
  example: WorkspaceExample;
  /** The files to start with: the files of the example, or of a share link. */
  files: WorkspaceFiles;
  /** Shows an output tab, such as `"terminal"`. */
  showTab: (tab: WorkspaceTab) => void;
}

/**
 * One run of the files. The workspace starts one in the setup of a component, so a run can use `onScopeDispose` to
 * stop. It starts a new run when `keeps` says that an example cannot open in this one.
 */
export interface WorkspaceRun {
  /** The files of the run, with the edits of the reader. */
  files: Readonly<Ref<WorkspaceFiles>>;
  /** Writes files. `replace` removes the files that `files` does not name. */
  setFiles: (files: WorkspaceFiles, options?: { mode?: "merge" | "replace" }) => Promise<void>;
  /** Whether `example` can open in this run. `false` makes the workspace start a new run for it. */
  keeps: (example: WorkspaceExample) => boolean;
  /** Opens the files of an example that this run keeps. */
  open: (example: WorkspaceExample, files: WorkspaceFiles) => Promise<void>;
  /** The output tabs of the runner, before the tabs of the page. */
  tabs: Readonly<Ref<readonly WorkspaceTabItem[]>>;
  /** Renders the panel of one of `tabs`. */
  panel: (tab: WorkspaceTab) => VNode | VNode[] | undefined;
  /** The state line in the bar. */
  state?: Readonly<Ref<WorkspaceRunState | undefined>>;
  /** The items of the More menu of the bar. Without items there is no More button. */
  actions?: Readonly<Ref<readonly WorkspaceMenuItem[]>>;
}

/**
 * Runs the files of a `Workspace`: `webContainer()` runs an app with a dev server, and `render()` renders the files to
 * a page with a function.
 */
export interface WorkspaceRunner {
  /** Starts a run. The workspace calls it in the setup of a component. */
  start: (input: WorkspaceRunInput) => WorkspaceRun;
  /** Whether this browser can run it. The workspace asks after mount. Without it, every browser can. */
  supported?: () => boolean;
  /** Only desktops start it on their own. Tablets start it on a tap, and phones show a card with Copy link and Download. */
  desktop?: boolean;
}

/** What `useWorkspace()` and the slots get. */
export interface WorkspaceContext {
  /** The files of the run, with the edits. */
  files: Readonly<Ref<WorkspaceFiles>>;
  /** Writes one file. */
  setFile: (path: string, contents: string) => Promise<void>;
  /** The paths whose contents differ from the files of the open example, sorted. */
  edited: ComputedRef<readonly string[]>;
  /** The open example. */
  example: ComputedRef<WorkspaceExample>;
  /** Opens `path` in the editor. */
  show: (path: string) => void;
  /** Shows an output tab, such as `"terminal"`. */
  showTab: (tab: WorkspaceTab) => void;
  /** Runs `action` at once when nothing is edited. Otherwise it asks the reader first, with `confirm` on the button. */
  guard: (title: string, confirm: string, action: () => void) => void;
  /** The runner of the workspace. */
  runner: WorkspaceRunner;
  /** The current run. */
  run: WorkspaceRun;
}

/** The slot props of `Workspace`: the context with its refs unwrapped. */
export type WorkspaceSlotProps = Omit<WorkspaceContext, "edited" | "example" | "files"> & {
  readonly edited: readonly string[];
  readonly example: WorkspaceExample;
  readonly files: WorkspaceFiles;
};

const contextKey: InjectionKey<WorkspaceContext> = Symbol("Workspace");

/** The workspace around the calling component: its files, edits, and actions. Call it in a slot of `Workspace`. */
export function useWorkspace(): WorkspaceContext {
  const context = inject(contextKey, undefined);
  if (!context) throw uiErrorDiagnostics.UI_R0002({ message: "useWorkspace() must be used in a component inside Workspace." });
  return context;
}

/** Where the page runs: `pending` before mount, then by the viewport width. */
export type WorkspaceDevice = "pending" | "phone" | "tablet" | "desktop";

/**
 * The device of the page, and whether the browser can run `runner`, known after mount. Desktops are 64rem wide or
 * more, and tablets 48rem. Use it to place the workspace, as a page with a lesson next to it does.
 */
export function useWorkspaceDevice(runner?: Pick<WorkspaceRunner, "supported">) {
  const device = ref<WorkspaceDevice>("pending");
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
    supported.value = runner?.supported?.() ?? true;
  });
  onBeforeUnmount(() => {
    for (const query of queries) query.removeEventListener("change", update);
  });
  return { device, supported };
}

const statusTones = { busy: "warning", error: "error", ready: "success" } as const;

function diff(base: Readonly<WorkspaceFiles>, files: Readonly<WorkspaceFiles>): string[] {
  const paths = new Set([...Object.keys(base), ...Object.keys(files)]);
  return [...paths].filter(path => base[path] !== files[path]).sort();
}

const filesOf = (example: WorkspaceExample): WorkspaceFiles => ({ ...example.files });

function firstFile(example: WorkspaceExample, files: Readonly<WorkspaceFiles>): string {
  return example.open !== undefined && files[example.open] !== undefined ? example.open : Object.keys(files).sort()[0] ?? "";
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const zipName = (prefix: string, example: WorkspaceExample) => prefix ? `${prefix}-${example.id}` : example.id;

const workspaceProps = {
  /** The examples to open. More than one shows an examples menu. */
  examples: { required: true as const, type: Array as PropType<readonly WorkspaceExample[]> },
  /** Runs the files: `webContainer()` or `render()`. */
  runner: { required: true as const, type: Object as PropType<WorkspaceRunner> },
  /** The id of the open example, such as from `?example=`. Defaults to the first example. Use `v-model:example`. */
  example: { default: undefined, type: String },
  /** The file in the editor. Use `v-model:selected`. */
  selected: { default: undefined, type: String },
  /** The steps of a lesson. They put the guide and the steps menu in the workspace. */
  steps: { default: () => [], type: Array as PropType<readonly WorkspaceStep[]> },
  /** The current step, from 0. Use `v-model:step`. */
  step: { default: undefined, type: Number },
  /** Where the guide goes: `top` over the code, or `side` in a column. Without steps, `side` puts the output over the code. */
  guide: { default: undefined, type: String as PropType<"top" | "side"> },
  /** More output tabs, after the tabs of the runner. Each one shows the slot with the name of its `value`. */
  tabs: { default: () => [], type: Array as PropType<readonly WorkspaceTabItem[]> },
  /** Copy link and Download, and opening `#code=` links. */
  share: { default: true, type: Boolean },
  /** The start of the zip name. The example id follows it, as in `vitehub-kv.zip`. */
  name: { default: "", type: String },
  /** Shows the examples as cards over the workspace on a first visit. A share link skips them and opens its files. */
  start: { default: false, type: Boolean },
  /** What the reader calls this, in lowercase, such as `"playground"`. It names the region, the Open button, and the notices. */
  label: { default: "workspace", type: String },
  /** Whether the workspace shows, for a runner that only desktops start. Set it to `true` to show it on a tablet. Use `v-model:open`. */
  open: { default: false, type: Boolean },
};

type WorkspaceProps = Readonly<ExtractPropTypes<typeof workspaceProps>>;

/** One run of the workspace. `Workspace` mounts a new one when an example cannot open in the current run. */
const WorkspaceSession = defineComponent({
  name: "WorkspaceSession",
  props: {
    config: { required: true, type: Object as PropType<WorkspaceProps> },
    /** The example that this run starts with. */
    booted: { required: true, type: Object as PropType<WorkspaceExample> },
    /** The files to start with: the files of the example, or of a share link. */
    files: { required: true, type: Object as PropType<WorkspaceFiles> },
    /** Shows the start screen over the workspace. */
    start: { default: false, type: Boolean },
    /** A notice over the workspace, such as for a share link. */
    notice: { default: undefined, type: String },
    step: { default: 0, type: Number },
  },
  emits: {
    "update:selected": (path: string) => typeof path === "string",
    "update:step": (step: number) => Number.isInteger(step),
    started: () => true,
    change: (example: WorkspaceExample) => !!example,
    remount: (example: WorkspaceExample) => !!example,
  },
  setup(props, { emit, slots }) {
    const UButton = useUIComponent("UButton");
    const UDropdownMenu = useUIComponent("UDropdownMenu");
    const UModal = useUIComponent("UModal");
    const config = props.config;

    const tab = ref<WorkspaceTab>();
    const showTab = (next: WorkspaceTab) => { tab.value = next; };
    const run = config.runner.start({ example: props.booted, files: { ...props.files }, showTab });

    const current = shallowRef(props.booted);
    // The page can give new files for the open example, such as a lesson for its next step.
    const example = computed(() => config.examples.find(item => item.id === current.value.id) ?? current.value);
    const edited = computed(() => diff(filesOf(example.value), run.files.value));
    const paths = computed(() => Object.keys(run.files.value).sort());
    const selected = ref(config.selected !== undefined && props.files[config.selected] !== undefined ? config.selected : firstFile(props.booted, props.files));
    watch(() => config.selected, (path) => { if (path !== undefined) selected.value = path; });
    watch(selected, path => emit("update:selected", path), { immediate: true });
    const wrap = ref(false);
    const cursor = ref<WorkspaceCursor>({ column: 1, line: 1 });
    const sidebar = ref(false);

    const confirm = ref<{ title: string, label: string, action: () => void }>();
    function guard(title: string, label: string, action: () => void) {
      if (edited.value.length === 0) action();
      else confirm.value = { title, label, action };
    }
    function confirmAction() {
      confirm.value?.action();
      confirm.value = undefined;
    }

    async function load(next: WorkspaceExample) {
      // Other dependencies or another snapshot need a new run.
      if (!run.keeps(next)) return emit("remount", next);
      current.value = next;
      const files = filesOf(next);
      selected.value = firstFile(next, files);
      emit("change", next);
      await run.open(next, files);
    }
    function pick(id: string) {
      const next = config.examples.find(item => item.id === id);
      if (!next || (next.id === example.value.id && edited.value.length === 0)) return;
      guard(`Open the ${next.label} example?`, "Replace files", () => void load(next));
    }
    function reset() {
      const title = config.examples.length > 1 ? `Discard your changes to the ${example.value.label} example?` : "Discard your changes?";
      guard(title, "Discard changes", () => void load(example.value));
    }

    // Copy link writes the share link. A link that chat apps would cut says so, in place of a toast. The `template`
    // key of the link stays, so older links open.
    const { copy, copied } = useCopy();
    const problem = ref<string>();
    async function copyLink(button?: EventTarget | null) {
      problem.value = undefined;
      const code = await encodePlaygroundLink({ template: example.value.id, files: run.files.value }, filesOf(example.value));
      const url = `${location.origin}${playgroundUrl(location.pathname, code)}`;
      if (url.length > playgroundLinkLimit) {
        problem.value = `This link would have ${(url.length / 1000).toFixed(1)} KB, and a share link can have ${playgroundLinkLimit / 1000} KB. Download the files instead.`;
        return;
      }
      if (!await copy(url)) problem.value = "The browser blocked the clipboard. Download the files instead.";
      else if (button instanceof HTMLElement) ring(button);
    }
    const download = () => downloadZip(run.files.value, zipName(config.name ?? "", example.value));

    const setFile = (path: string, contents: string) => run.setFiles({ [path]: contents });
    const show = (path: string) => { selected.value = path; };
    const context: WorkspaceContext = { edited, example, files: run.files, guard, run, runner: config.runner, setFile, show, showTab };
    provide(contextKey, context);
    provideWorkspaceFileOpener({ show });
    // The run and the runner keep their refs, so the slots can pass them on.
    const slotProps: WorkspaceSlotProps = reactive({ ...context, run: markRaw(run), runner: markRaw(config.runner) });

    const source = computed({
      get: () => run.files.value[selected.value] ?? "",
      // A failed write shows in the output, and the next edit writes the file again.
      set: value => void setFile(selected.value, value).catch(() => {}),
    });

    const layout = computed<WorkspaceLayout>(() => {
      if (config.steps.length) return `guide-${config.guide ?? "top"}`;
      return config.guide ? `guide-${config.guide}` : "side";
    });
    const tabItems = computed<WorkspaceTabItem[]>(() => [...run.tabs.value, ...config.tabs]);

    function bar(): (VNode | undefined)[] {
      const state = run.state?.value;
      const actions = run.actions?.value ?? [];
      const hasSidebar = !!slots.sidebar;
      const examples = config.steps.length
        ? () => h(WorkspaceSteps, { step: props.step, steps: config.steps, "onUpdate:step": (step: number) => emit("update:step", step) })
        : config.examples.length > 1
          ? () => h(WorkspaceExamples, { examples: config.examples, modelValue: example.value.id, "onUpdate:modelValue": pick })
          : undefined;
      return [
        h(WorkspaceBar, {
          // The start screen covers the workspace, so only its cards take focus.
          inert: props.start ? "" : undefined,
          sidebar: hasSidebar ? sidebar.value : undefined,
          sidebarId: hasSidebar ? "vh-workspace-sidebar" : undefined,
          "onUpdate:sidebar": (open: boolean) => { sidebar.value = open; },
        }, {
          lead: slots["bar-lead"] && (() => slots["bar-lead"]?.(slotProps) ?? []),
          examples,
          default: state
            ? () => [h("span", { class: "vh-workspace-run-state", role: "status" }, h(Status, { colored: state.tone === "error", label: state.label, pulse: state.tone === "busy", tone: statusTones[state.tone] }))]
            : undefined,
          actions: () => [
            slots["bar-actions"]?.(slotProps),
            // With a sidebar, Reset, Download and Copy link sit at its bottom instead.
            hasSidebar ? undefined : h(UButton, { color: "neutral", disabled: edited.value.length === 0, icon: "i-lucide-rotate-ccw", label: "Reset", variant: "ghost", onClick: reset }),
            ...config.share && !hasSidebar
              ? [
                  h(UButton, { color: "neutral", icon: "i-lucide-download", label: "Download", variant: "ghost", onClick: download }),
                  h(UButton, { color: "neutral", icon: copied.value ? "i-lucide-check" : "i-lucide-link", label: copied.value ? "Link copied" : "Copy link", variant: "outline", onClick: (event: MouseEvent) => void copyLink(event.currentTarget) }),
                ]
              : [],
            actions.length
              ? h(UDropdownMenu, {
                  content: { align: "end" },
                  items: [actions.map(item => ({ disabled: item.disabled, icon: item.icon, label: item.label, onSelect: item.onSelect }))],
                }, () => h(UButton, { "aria-label": "More actions", color: "neutral", icon: "i-lucide-ellipsis", variant: "ghost" }))
              : undefined,
          ],
        }),
        hasSidebar
          ? h(WorkspaceSidebar, {
              actions: (config.share ? ["reset", "download", "copy-link"] : ["reset"]) satisfies WorkspaceSidebarAction[],
              copied: copied.value,
              id: "vh-workspace-sidebar",
              open: sidebar.value,
              "onUpdate:open": (open: boolean) => { sidebar.value = open; },
              onReset: reset,
              onDownload: download,
              "onCopy-link": () => void copyLink(),
            }, () => slots.sidebar?.(slotProps))
          : undefined,
        props.start
          ? h(WorkspaceStart, {
              examples: config.examples,
              onPick: (id: string) => {
                emit("started");
                pick(id);
              },
            })
          : undefined,
      ];
    }

    return () => {
      const notice = problem.value ?? props.notice;
      const shellSlots: Record<string, (() => VNode | (VNode | undefined)[] | undefined) | undefined> = {
        bar,
        banner: notice || slots.banner
          ? () => [
              notice ? h("div", { class: "vh-workspace-notice", role: "status" }, notice) : undefined,
              ...slots.banner?.(slotProps) ?? [],
            ]
          : undefined,
        files: () => [
          h("div", { class: "vh-ws-head" }, h("span", { class: "vh-ws-muted" }, "Files")),
          h(WorkspaceFileTree, { edited: edited.value, paths: paths.value, selected: selected.value, "onUpdate:selected": show }),
        ],
        "editor-head": () => h(WorkspaceEditorHead, { path: selected.value, wrap: wrap.value, "onUpdate:wrap": (next: boolean) => { wrap.value = next; } }),
        editor: () => h(WorkspaceEditor, {
          modelValue: source.value,
          path: selected.value,
          wrap: wrap.value,
          onCursor: (next: WorkspaceCursor) => { cursor.value = next; },
          "onUpdate:modelValue": (value: string) => { source.value = value; },
          "onUpdate:wrap": (next: boolean) => { wrap.value = next; },
        }),
        status: () => h(WorkspaceStatus, { cursor: cursor.value, path: selected.value }),
        guide: config.steps.length
          ? () => h(WorkspaceGuide, { step: props.step, steps: config.steps, "onUpdate:step": (step: number) => emit("update:step", step) }, {
              default: () => slots.guide?.(slotProps),
            })
          : slots.guide && (() => slots.guide?.(slotProps)),
        ...Object.fromEntries(run.tabs.value.map(item => [`tab-${item.value}`, () => run.panel(item.value)])),
        ...Object.fromEntries(config.tabs.map(item => [`tab-${item.value}`, () => slots[item.value]?.(slotProps)])),
      };
      return h("div", { class: "vh-workspace-session" }, [
        h(WorkspaceShell, {
          covered: props.start,
          label: capitalize(config.label ?? "workspace"),
          layout: layout.value,
          storageKey: `vitehub:workspace:${config.label}:${layout.value}`,
          tab: tab.value,
          tabs: tabItems.value,
          "onUpdate:tab": showTab,
        }, shellSlots),
        h(UModal, {
          description: config.share
            ? "Your edits to the current files are lost. Copy a link or download them first to keep them."
            : "Your edits to the current files are lost.",
          open: !!confirm.value,
          title: confirm.value?.title,
          "onUpdate:open": (open: boolean) => { if (!open) confirm.value = undefined; },
        }, {
          footer: () => h("div", { class: "vh-workspace-modal-actions" }, [
            h(UButton, { color: "neutral", label: "Cancel", variant: "ghost", onClick: () => { confirm.value = undefined; } }),
            h(UButton, { color: "neutral", label: confirm.value?.label, onClick: confirmAction }),
          ]),
        }),
      ]);
    };
  },
});

/**
 * A complete workspace: the bar, the file tree, the editor, the output, and with `steps` the guide of a lesson. The
 * runner runs the files: `webContainer()` runs an app in the browser, and `render()` renders the files to a page. It
 * tracks edits, asks before it discards them, copies share links, and downloads zips.
 */
export const Workspace = defineComponent({
  name: "Workspace",
  props: workspaceProps,
  emits: {
    /** The reader opened an example, or discarded the changes to one. */
    "update:example": (id: string) => typeof id === "string",
    "update:selected": (path: string) => typeof path === "string",
    "update:step": (step: number) => Number.isInteger(step),
    "update:open": (open: boolean) => typeof open === "boolean",
  },
  setup(props, { emit, slots }) {
    const UButton = useUIComponent("UButton");
    const { device, supported } = useWorkspaceDevice(props.runner);
    const first = () => props.examples.find(item => item.id === props.example) ?? props.examples[0]!;

    // `id` changes when the files need a new run, such as for an example with other dependencies. Only share links pin
    // files. A deferred run or a download reads the current files of its example.
    const session = shallowRef<{ id: number, example: WorkspaceExample, files?: WorkspaceFiles }>();
    const active = computed(() => props.examples.find(item => item.id === session.value?.example.id) ?? session.value?.example ?? first());
    const link = ref<"restored" | "invalid">();
    // The start screen shows until the reader picks an example. A share link never shows it.
    const starting = ref(props.start);
    const localStep = ref(props.step ?? 0);
    watch(() => props.step, (step) => { if (step !== undefined) localStep.value = step; });
    const step = computed(() => Math.min(Math.max(0, props.steps.length - 1), Math.max(0, localStep.value)));
    function setStep(next: number) {
      localStep.value = next;
      emit("update:step", next);
    }

    function boot(example: WorkspaceExample, files?: WorkspaceFiles) {
      session.value = { example, files, id: (session.value?.id ?? 0) + 1 };
    }

    let restoration = 0;
    /** A `#code=…` link holds files. They open on their example. */
    async function restore() {
      const request = ++restoration;
      const code = props.share ? readPlaygroundHash(location.hash) : undefined;
      const decoded = code ? await decodePlaygroundLink(code, props.examples.map(item => ({ files: filesOf(item), id: item.id }))) : undefined;
      if (request !== restoration) return;
      const shared = decoded?.template === undefined ? undefined : props.examples.find(item => item.id === decoded.template);
      link.value = shared ? "restored" : code ? "invalid" : undefined;
      if (shared && decoded) {
        starting.value = false;
        return boot(shared, decoded.files);
      }
      boot(first());
    }
    onMounted(() => {
      void restore();
      if (props.share) window.addEventListener("hashchange", restore);
    });
    onBeforeUnmount(() => window.removeEventListener("hashchange", restore));

    function opened(example: WorkspaceExample) {
      // The share link no longer matches the files.
      link.value = undefined;
      emit("update:example", example.id);
    }

    const requested = ref(props.open);
    watch(() => props.open, (open) => { requested.value = open; });
    // A desktop runner starts on its own only on desktops, on a tap on tablets, and never on phones.
    const shown = computed(() => {
      if (!session.value || supported.value !== true) return false;
      if (!props.runner.desktop) return true;
      return device.value === "desktop" || (device.value === "tablet" && requested.value);
    });
    watch(shown, (value) => { if (value !== props.open) emit("update:open", value); });

    const { copy: copyPage, copied } = useCopy({ duration: 1500 });
    function download() {
      downloadZip(session.value?.files ?? filesOf(active.value), zipName(props.name, active.value));
    }
    const downloadButton = () => h(UButton, { color: "neutral", icon: "i-lucide-download", label: "Download files", size: "sm", variant: "outline", onClick: download });

    function notice(): string | undefined {
      if (!link.value || !session.value) return undefined;
      const label = session.value.example.label;
      const many = props.examples.length > 1;
      return link.value === "invalid"
        ? `This link has no files that the ${props.label} can read.${many ? ` It opened the ${label} example.` : ""}`
        : `You opened shared files${many ? ` on the ${label} example` : ""}.`;
    }

    function gate(): VNode {
      // A runner that any device runs waits only for mount.
      if (!props.runner.desktop) {
        return h("div", { class: "vh-workspace-gate", "data-state": "pending" }, h("div", { class: "vh-workspace-placeholder" }, [
          h("div", { class: "vh-workspace-placeholder-bar" }),
          h("p", { class: "vh-workspace-muted" }, `Starting the ${props.label}`),
        ]));
      }
      // Before mount the page cannot know the device, so CSS shows the phone card or the placeholder by width.
      const state = device.value === "pending" ? "pending"
        : device.value === "phone" ? "phone"
          : supported.value === false ? "unsupported"
            : device.value === "tablet" ? "tablet"
              : "pending";
      const phone = h("aside", { class: "vh-workspace-card vh-workspace-phone" }, [
        h("p", { class: "vh-workspace-strong" }, `The live ${props.label} runs in a desktop browser. Open this page on a desktop to edit and run the code.`),
        h("div", { class: "vh-workspace-actions" }, [
          h(UButton, { color: "neutral", icon: copied.value ? "i-lucide-check" : "i-lucide-link", label: copied.value ? "Copied" : "Copy link", size: "sm", variant: "outline", onClick: (event: MouseEvent) => {
            const button = event.currentTarget;
            void copyPage(location.href).then(ok => ok && button instanceof HTMLElement && ring(button));
          } }),
          downloadButton(),
        ]),
      ]);
      const card = state === "pending" || state === "phone"
        ? phone
        : state === "unsupported"
          ? h("div", { class: "vh-workspace-unsupported" }, [
              h(BrowserSupportNotice, {
                description: "Download the files to run the app on your machine, or open this page in Chrome, Edge, or Firefox on a desktop to edit and run it here.",
                supported: false,
              }),
              h("div", { class: "vh-workspace-actions" }, [downloadButton()]),
            ])
          : h("div", { class: "vh-workspace-card" }, [
              h("p", { class: "vh-workspace-muted" }, "Edit and run the code in your browser. The first start downloads the dependencies of the app."),
              h("div", { class: "vh-workspace-actions" }, [
                h(UButton, { color: "neutral", icon: "i-lucide-play", label: `Open ${props.label}`, onClick: () => { requested.value = true; } }),
              ]),
            ]);
      return h("div", { class: "vh-workspace-gate", "data-state": state }, [
        state === "pending"
          ? h("div", { class: "vh-workspace-placeholder" }, [h("div", { class: "vh-workspace-placeholder-bar" }), h("p", { class: "vh-workspace-muted" }, `Starting the ${props.label}`)])
          : undefined,
        h("div", { class: "vh-workspace-gate-content" }, [slots.intro?.(), card, slots.fallback?.()]),
      ]);
    }

    return () => {
      const current = session.value;
      return h("div", { class: "vh-workspace", "data-runner": props.runner.desktop ? "desktop" : "any" }, [
        shown.value && current
          ? h(WorkspaceSession, {
              key: current.id,
              booted: active.value,
              config: props,
              files: current.files ?? filesOf(active.value),
              notice: notice(),
              start: starting.value && link.value !== "restored",
              step: step.value,
              onChange: opened,
              onStarted: () => { starting.value = false; },
              onRemount: (example: WorkspaceExample) => {
                opened(example);
                boot(example);
              },
              "onUpdate:selected": (path: string) => emit("update:selected", path),
              "onUpdate:step": setStep,
            }, slots)
          : gate(),
      ]);
    };
  },
});
