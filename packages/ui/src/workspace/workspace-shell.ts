import { computed, defineComponent, h, onMounted, type PropType, ref, type Slots, type VNode, watch } from "vue";
import { useUIComponent } from "../internal/nuxt-ui.ts";

/**
 * Where the guide, the code, and the output go.
 * - `side`: the code, and the output at the side.
 * - `guide-top`: the guide over the code, and the output at the side. Drag the line under the guide to resize it.
 * - `guide-side`: the guide in a column on the left, up to 360px and at most half the shell width. On the right, the
 *   output takes 40% at the top and the code sits under it.
 */
export type WorkspaceLayout = "side" | "guide-top" | "guide-side";
/** A built-in panel or the value of a panel that the page adds. */
export type WorkspaceTab = "preview" | "terminal" | "connect" | (string & {});

/** One tab of the panel group. */
export interface WorkspaceTabItem {
  value: WorkspaceTab;
  label: string;
  /** A short count or state next to the label, such as the number of connected accounts. */
  badge?: string | number;
}

/**
 * Split sizes. `files` is the width of the files in pixels. `code` is the width of the code column in percent of the
 * shell, in `side` and `guide-top`. `guide` is the height of the guide in percent of the code column, in `guide-top`.
 */
export interface WorkspaceSplits {
  files: number;
  code: number;
  guide: number;
}

// The files take 199px and their 1px line, so the editor starts at 200px.
const defaultSplits: Record<WorkspaceLayout, WorkspaceSplits> = {
  "side": { files: 199, code: 50, guide: 46 },
  "guide-top": { files: 199, code: 54, guide: 46 },
  "guide-side": { files: 199, code: 50, guide: 46 },
};

const limits: Record<keyof WorkspaceSplits, [number, number, number]> = {
  // [min, max, keyboard step]
  files: [120, 420, 16],
  code: [25, 75, 5],
  guide: [15, 75, 5],
};
const editorReserve = 120;

const builtInTabs: readonly WorkspaceTabItem[] = [
  { label: "Preview", value: "preview" },
  { label: "Terminal", value: "terminal" },
  { label: "Connect", value: "connect" },
];

const layoutSlots = new Set(["bar", "editor", "editor-head", "files", "guide", "overlay", "status"]);

function clamp(key: keyof WorkspaceSplits, value: number) {
  const [min, max] = limits[key];
  return Math.round(Math.min(max, Math.max(min, value)));
}

function readSplits(key: string | false, layout: WorkspaceLayout): WorkspaceSplits {
  const fallback = { ...defaultSplits[layout] };
  if (!key || typeof window === "undefined") return fallback;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return fallback;
    for (const name of Object.keys(fallback) as (keyof WorkspaceSplits)[]) {
      const size = Reflect.get(value, name);
      if (typeof size === "number" && Number.isFinite(size)) fallback[name] = clamp(name, size);
    }
  }
  catch {
    // A blocked or malformed localStorage keeps the default splits.
  }
  return fallback;
}

/**
 * A resize handle. It uses pointer capture so a drag over the preview iframe keeps working,
 * and it moves by a step with the arrow keys.
 */
function separator(options: {
  name: keyof WorkspaceSplits
  label: string
  max?: number
  orientation: "horizontal" | "vertical"
  splits: WorkspaceSplits
  container: () => HTMLElement | null
  set: (name: keyof WorkspaceSplits, value: number) => void
  measure: (event: PointerEvent, rect: DOMRect) => number
}): VNode {
  const { name, orientation, splits } = options;
  const [defaultMin, defaultMax, step] = limits[name];
  const max = options.max ?? defaultMax;
  const min = Math.min(defaultMin, max);
  const decrease = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
  const increase = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
  return h("div", {
    "aria-label": options.label,
    "aria-orientation": orientation,
    "aria-valuemax": max,
    "aria-valuemin": min,
    "aria-valuenow": splits[name],
    class: ["vh-ws-separator", `vh-ws-separator--${orientation}`],
    "data-split": name,
    role: "separator",
    tabindex: 0,
    onKeydown(event: KeyboardEvent) {
      if (event.key === decrease) options.set(name, splits[name] - step);
      else if (event.key === increase) options.set(name, splits[name] + step);
      else if (event.key === "Home") options.set(name, min);
      else if (event.key === "End") options.set(name, max);
      else return;
      event.preventDefault();
    },
    onPointerdown(event: PointerEvent) {
      const container = options.container();
      if (!container || event.button !== 0) return;
      const handle = event.currentTarget;
      if (!(handle instanceof HTMLElement)) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const rect = container.getBoundingClientRect();
      const move = (next: PointerEvent) => options.set(name, options.measure(next, rect));
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    },
  });
}

/**
 * The frame of a workspace. Slots: `bar` (44px, over everything), `files`, `editor-head` (32px, over the editor),
 * `editor`, `status` (24px, under the editor), `guide`, one slot per tab (`preview`, `terminal`, `connect`, or
 * `tab-<value>` for a custom tab), and `overlay` (over the body). The tab bar is 32px too, so its bottom line meets the
 * bottom line of `editor-head`.
 */
export const WorkspaceShell = defineComponent({
  name: "WorkspaceShell",
  props: {
    layout: { default: "side", type: String as PropType<WorkspaceLayout> },
    /** The visible tab. Use `v-model:tab`. */
    tab: { default: undefined, type: String as PropType<WorkspaceTab> },
    /**
     * The tabs of the output, in order. Defaults to Preview, Terminal, and Connect, for the slots that are set.
     */
    tabs: { default: undefined, type: Array as PropType<readonly WorkspaceTabItem[]> },
    /** The localStorage key for split sizes. `false` keeps them in memory. Defaults to one key per layout. */
    storageKey: { default: undefined, type: [String, Boolean] as PropType<string | false> },
    /** The accessible name of the workspace region. */
    label: { default: "Workspace", type: String },
  },
  emits: {
    "update:tab": (tab: WorkspaceTab) => typeof tab === "string",
  },
  setup(props, { emit, slots }) {
    const root = ref<HTMLElement | null>(null);
    const codePane = ref<HTMLElement | null>(null);
    const filesMax = ref(limits.files[1]);
    const key = computed(() => props.storageKey === false ? false : props.storageKey ?? `vitehub:workspace:${props.layout}`);
    const splits = ref<WorkspaceSplits>({ ...defaultSplits[props.layout] });
    const localTab = ref<WorkspaceTab>();

    onMounted(() => { splits.value = readSplits(key.value, props.layout); });
    watch(() => props.layout, () => { splits.value = readSplits(key.value, props.layout); });
    watch(codePane, (pane, _, onCleanup) => {
      if (!pane || typeof ResizeObserver === "undefined") return;
      const measure = (width: number) => {
        const available = width - Math.min(editorReserve, width / 2) - 1;
        filesMax.value = Math.max(0, Math.min(limits.files[1], Math.floor(available)));
      };
      measure(pane.clientWidth);
      const observer = new ResizeObserver(([entry]) => {
        if (entry) measure(entry.contentRect.width);
      });
      observer.observe(pane);
      onCleanup(() => observer.disconnect());
    }, { flush: "post" });

    function set(name: keyof WorkspaceSplits, value: number) {
      const size = clamp(name, value);
      splits.value = { ...splits.value, [name]: name === "files" ? Math.min(filesMax.value, size) : size };
      if (!key.value) return;
      try { window.localStorage.setItem(key.value, JSON.stringify(splits.value)); }
      catch { /* The split still applies for this page. */ }
    }

    const items = computed(() => props.tabs ?? builtInTabs.filter(item => slots[item.value]));
    const tabs = computed(() => items.value.map(item => item.value));
    const active = computed(() => {
      const wanted = props.tab ?? localTab.value;
      if (wanted && tabs.value.includes(wanted)) return wanted;
      return tabs.value[0];
    });

    function select(tab: WorkspaceTab) {
      localTab.value = tab;
      emit("update:tab", tab);
    }

    const slotProps = () => ({ layout: props.layout, tab: active.value, showTab: select });
    const UTabs = useUIComponent("UTabs");

    function panelContent(name: WorkspaceTab) {
      const custom = slots[`tab-${name}`];
      if (custom) return custom(slotProps());
      if (!layoutSlots.has(name) && !name.startsWith("tab-")) return renderSlot(slots, name, slotProps());
    }

    // UTabs draws the strip and moves between tabs with the arrow keys. The panels stay here, mounted and laid over each
    // other, so the terminal keeps its size and output and the preview keeps its page while another tab shows.
    function output(): VNode | undefined {
      if (tabs.value.length === 0) return undefined;
      const panels = tabs.value.map(name => h("div", {
        "aria-label": items.value.find(item => item.value === name)?.label,
        class: ["vh-ws-tab-panel", active.value !== name && "is-hidden"],
        "data-tab": name,
        inert: active.value === name ? undefined : "",
        key: name,
        role: "tabpanel",
      }, panelContent(name)));
      return h("div", { class: "vh-ws-pane vh-ws-pane--output" }, [
        h(UTabs, {
          "aria-label": "Workspace panels",
          class: "vh-ws-tab-list",
          content: false,
          items: items.value.map(({ badge, label, value }) => ({ badge: badge === "" ? undefined : badge, label, value })),
          modelValue: active.value,
          "onUpdate:modelValue": (value: string | number) => {
            const tab = tabs.value.find(name => name === value);
            if (tab) select(tab);
          },
        }),
        h("div", { class: "vh-ws-tab-panels" }, panels),
      ]);
    }

    return () => {
      const s = { ...splits.value, files: Math.min(splits.value.files, filesMax.value) };
      const layout = props.layout;
      const body = () => root.value?.querySelector<HTMLElement>(".vh-ws-body") ?? null;

      // The files and the editor column: the head row, the editor, and the status line.
      const code = (style?: Record<string, string>) => h("div", { class: "vh-ws-pane vh-ws-code", ref: codePane, style }, [
        ...slots.files
          ? [
              h("div", { class: "vh-ws-pane vh-ws-pane--files", style: { flexBasis: `${s.files}px` } }, renderSlot(slots, "files", slotProps())),
              separator({
                container: () => codePane.value,
                label: "Resize files",
                max: filesMax.value,
                measure: (event, rect) => event.clientX - rect.left,
                name: "files",
                orientation: "vertical",
                set,
                splits: s,
              }),
            ]
          : [],
        h("div", { class: "vh-ws-pane vh-ws-pane--editor" }, [
          slots["editor-head"] ? h("div", { class: "vh-ws-head vh-ws-editor-head" }, renderSlot(slots, "editor-head", slotProps())) : undefined,
          h("div", { class: "vh-ws-pane vh-ws-editor-body" }, renderSlot(slots, "editor", slotProps())),
          slots.status ? h("div", { class: "vh-ws-status" }, renderSlot(slots, "status", slotProps())) : undefined,
        ]),
      ]);
      const guide = (style?: Record<string, string>) => slots.guide
        ? h("div", { class: "vh-ws-pane vh-ws-guide", style }, renderSlot(slots, "guide", slotProps()))
        : undefined;
      const codeSeparator = () => separator({
        container: body,
        label: "Resize code",
        measure: (event, rect) => ((event.clientX - rect.left) / rect.width) * 100,
        name: "code",
        orientation: "vertical",
        set,
        splits: s,
      });

      let children: (VNode | undefined)[];
      if (layout === "guide-side") {
        // The output does not need the full height, so it takes a fixed part and the code sits under it.
        children = [guide(), h("div", { class: "vh-ws-pane vh-ws-stack" }, [output(), code()])];
      }
      else {
        const panels = output();
        // Without an output the code takes the full width.
        const width = panels ? { flex: `0 0 ${s.code}%` } : undefined;
        const column = layout === "guide-top" && slots.guide
          ? h("div", { class: "vh-ws-pane vh-ws-column", style: width }, [
              guide({ flex: `0 0 ${s.guide}%` }),
              separator({
                container: () => root.value?.querySelector<HTMLElement>(".vh-ws-column") ?? null,
                label: "Resize guide",
                measure: (event, rect) => ((event.clientY - rect.top) / rect.height) * 100,
                name: "guide",
                orientation: "horizontal",
                set,
                splits: s,
              }),
              code(),
            ])
          : code(width);
        children = panels ? [column, codeSeparator(), panels] : [column];
      }

      return h("section", {
        "aria-label": props.label,
        class: ["vh-ws-shell", `vh-ws-shell--${layout}`],
        "data-layout": layout,
        ref: root,
      }, [
        slots.bar ? h("div", { class: "vh-ws-bar" }, renderSlot(slots, "bar", slotProps())) : undefined,
        h("div", { class: "vh-ws-body" }, children),
        slots.overlay ? h("div", { class: "vh-ws-overlay" }, renderSlot(slots, "overlay", slotProps())) : undefined,
      ]);
    };
  },
});

function renderSlot(slots: Slots, name: string, props: Record<string, unknown>) {
  return slots[name]?.(props);
}
