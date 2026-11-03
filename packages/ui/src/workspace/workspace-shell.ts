import { computed, defineComponent, h, onMounted, type PropType, ref, type Slots, useId, type VNode, watch } from "vue";

export type WorkspaceLayout = "tutorial" | "playground";
export type WorkspaceTab = "preview" | "terminal" | "connect";

/** Split sizes. `files` is in pixels. `main` and `side` are percents of the shell. */
export interface WorkspaceSplits {
  files: number;
  main: number;
  side: number;
}

const defaultSplits: Record<WorkspaceLayout, WorkspaceSplits> = {
  // `main` is the editor height in a tutorial, and the editor height above the terminal in a playground.
  playground: { files: 200, main: 65, side: 45 },
  tutorial: { files: 180, main: 55, side: 45 },
};

const limits: Record<keyof WorkspaceSplits, [number, number, number]> = {
  // [min, max, keyboard step]
  files: [120, 420, 16],
  main: [20, 80, 5],
  side: [25, 75, 5],
};

const tabLabels: Record<WorkspaceTab, string> = { connect: "Connect", preview: "Preview", terminal: "Terminal" };

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
  orientation: "horizontal" | "vertical"
  splits: WorkspaceSplits
  container: () => HTMLElement | null
  set: (name: keyof WorkspaceSplits, value: number) => void
  measure: (event: PointerEvent, rect: DOMRect) => number
}): VNode {
  const { name, orientation, splits } = options;
  const [min, max, step] = limits[name];
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

export const WorkspaceShell = defineComponent({
  name: "WorkspaceShell",
  props: {
    layout: { default: "tutorial", type: String as PropType<WorkspaceLayout> },
    /** The visible tab. Use `v-model:tab`. */
    tab: { default: undefined, type: String as PropType<WorkspaceTab> },
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
    const key = computed(() => props.storageKey === false ? false : props.storageKey ?? `vitehub:workspace:${props.layout}`);
    const splits = ref<WorkspaceSplits>({ ...defaultSplits[props.layout] });
    const localTab = ref<WorkspaceTab>();

    onMounted(() => { splits.value = readSplits(key.value, props.layout); });
    watch(() => props.layout, () => { splits.value = readSplits(key.value, props.layout); });

    function set(name: keyof WorkspaceSplits, value: number) {
      splits.value = { ...splits.value, [name]: clamp(name, value) };
      if (!key.value) return;
      try { window.localStorage.setItem(key.value, JSON.stringify(splits.value)); }
      catch { /* The split still applies for this page. */ }
    }

    // In a playground the terminal sits under the editor, so the tabs hold the preview and Connect.
    const tabs = computed(() => {
      const names: WorkspaceTab[] = props.layout === "playground" ? ["preview", "connect"] : ["preview", "terminal", "connect"];
      return names.filter(name => slots[name]);
    });
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
    const id = `vh-ws${useId()}`.replace(/[^\w-]/g, "");

    function tabList(): VNode | undefined {
      if (tabs.value.length === 0) return undefined;
      const panels = tabs.value.map(name => h("div", {
        "aria-labelledby": `${id}-tab-${name}`,
        class: ["vh-ws-tab-panel", active.value !== name && "is-hidden"],
        "data-tab": name,
        id: `${id}-panel-${name}`,
        inert: active.value === name ? undefined : "",
        key: name,
        role: "tabpanel",
      }, renderSlot(slots, name, slotProps())));
      return h("div", { class: "vh-ws-tabs" }, [
        h("div", {
          "aria-label": "Workspace panels",
          class: "vh-ws-tab-list",
          role: "tablist",
          onKeydown(event: KeyboardEvent) {
            const index = active.value ? tabs.value.indexOf(active.value) : 0;
            const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!offset) return;
            event.preventDefault();
            const next = tabs.value[(index + offset + tabs.value.length) % tabs.value.length];
            if (!next) return;
            select(next);
            root.value?.querySelector<HTMLElement>(`#${id}-tab-${next}`)?.focus();
          },
        }, tabs.value.map(name => h("button", {
          "aria-controls": `${id}-panel-${name}`,
          "aria-selected": active.value === name ? "true" : "false",
          class: "vh-ws-tab",
          id: `${id}-tab-${name}`,
          key: name,
          role: "tab",
          tabindex: active.value === name ? 0 : -1,
          type: "button",
          onClick: () => select(name),
        }, tabLabels[name]))),
        h("div", { class: "vh-ws-tab-panels" }, panels),
      ]);
    }

    return () => {
      const s = splits.value;
      const container = () => root.value?.querySelector<HTMLElement>(".vh-ws-body") ?? null;
      const filesSplit = slots.files
        ? [
            h("div", { class: "vh-ws-pane vh-ws-pane--files", style: { flexBasis: `${s.files}px` } }, renderSlot(slots, "files", slotProps())),
            separator({ container, label: "Resize files", measure: (event, rect) => event.clientX - rect.left, name: "files", orientation: "vertical", set, splits: s }),
          ]
        : [];
      const editor = h("div", { class: "vh-ws-pane vh-ws-pane--editor" }, renderSlot(slots, "editor", slotProps()));

      let body: VNode;
      if (props.layout === "playground") {
        const center = slots.terminal
          ? h("div", { class: "vh-ws-stack" }, [
              h("div", { class: "vh-ws-pane", style: { flexBasis: `${s.main}%` } }, [editor]),
              separator({
                container: () => root.value?.querySelector<HTMLElement>(".vh-ws-stack") ?? null,
                label: "Resize terminal",
                measure: (event, rect) => ((event.clientY - rect.top) / rect.height) * 100,
                name: "main",
                orientation: "horizontal",
                set,
                splits: s,
              }),
              h("div", { class: "vh-ws-pane vh-ws-pane--terminal" }, renderSlot(slots, "terminal", slotProps())),
            ])
          : editor;
        body = h("div", { class: "vh-ws-body vh-ws-body--row" }, [
          ...filesSplit,
          h("div", { class: "vh-ws-pane vh-ws-pane--center" }, [center]),
          separator({ container, label: "Resize preview", measure: (event, rect) => ((rect.right - event.clientX) / rect.width) * 100, name: "side", orientation: "vertical", set, splits: s }),
          h("div", { class: "vh-ws-pane vh-ws-pane--side", style: { flexBasis: `${s.side}%` } }, [tabList()]),
        ]);
      }
      else {
        body = h("div", { class: "vh-ws-body vh-ws-body--column" }, [
          h("div", { class: "vh-ws-row", style: { flexBasis: `${s.main}%` } }, [...filesSplit, editor]),
          separator({ container, label: "Resize editor", measure: (event, rect) => ((event.clientY - rect.top) / rect.height) * 100, name: "main", orientation: "horizontal", set, splits: s }),
          h("div", { class: "vh-ws-pane vh-ws-pane--panels" }, [tabList()]),
        ]);
      }

      return h("section", {
        "aria-label": props.label,
        class: ["vh-ws-shell", `vh-ws-shell--${props.layout}`],
        "data-layout": props.layout,
        ref: root,
      }, [
        slots.toolbar ? h("div", { class: "vh-ws-toolbar" }, renderSlot(slots, "toolbar", slotProps())) : undefined,
        body,
        slots.overlay ? h("div", { class: "vh-ws-overlay" }, renderSlot(slots, "overlay", slotProps())) : undefined,
      ]);
    };
  },
});

function renderSlot(slots: Slots, name: string, props: Record<string, unknown>) {
  return slots[name]?.(props);
}
