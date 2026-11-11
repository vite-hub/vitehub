// The layout and the visual details follow T3 Code's thread view (https://github.com/pingdotgg/t3code, MIT License,
// Copyright (c) T3 Tools Inc.): a centered timeline, a details card at the top right, and a right panel of surfaces
// whose toggle stays in the top right corner whether the panel is open or closed.
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import {
  computed,
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type PropType,
  type VNode,
} from "vue";
import { useUIComponent } from "../internal/nuxt-ui.ts";
import { Markdown } from "./markdown.ts";

/** A surface that the right panel can show, such as the Workspace files or the session's changes. */
export interface AgentSessionSurface {
  id: string;
  label: string;
  /** An Iconify name, such as `i-lucide-files`. */
  icon: string;
  /** One key that opens the surface while the empty panel has focus. */
  shortcut?: string;
}

export type AgentSessionWorkKind =
  | "command"
  | "edit"
  | "read"
  | "search"
  | "web"
  | "mcp"
  | "skill"
  | "thinking"
  | "plan"
  | "tool";

export interface AgentSessionWorkEntry {
  id: string;
  kind: AgentSessionWorkKind;
  label: string;
  /** Text that shows after the label, muted. */
  preview?: string;
  /** Text that shows when the row opens, such as a command's output. */
  detail?: string;
  status?: "running" | "error" | "done";
  /** A short value at the end of the row, such as `+12 −3` or `1.2 s`. */
  trailing?: string;
}

export type AgentSessionItem =
  | { type: "user"; id: string; text: string; createdAt?: string }
  | { type: "assistant"; id: string; text: string; createdAt?: string }
  | { type: "work"; id: string; label?: string; entries: AgentSessionWorkEntry[]; defaultOpen?: boolean }
  | { type: "divider"; id: string; label: string };

const workIcons: Record<AgentSessionWorkKind, string> = {
  command: "i-lucide-terminal",
  edit: "i-lucide-file-pen-line",
  read: "i-lucide-file-text",
  search: "i-lucide-search",
  web: "i-lucide-globe",
  mcp: "i-lucide-plug",
  skill: "i-lucide-sparkles",
  thinking: "i-lucide-brain",
  plan: "i-lucide-list-checks",
  tool: "i-lucide-wrench",
};

interface StoredLayout {
  panelOpen?: boolean;
  detailsOpen?: boolean;
  width?: number;
  tabs?: string[];
  active?: string | null;
  maximized?: boolean;
}

function readLayout(key: string | undefined): StoredLayout {
  if (!key || typeof localStorage === "undefined") return {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    return value && typeof value === "object" ? (value as StoredLayout) : {};
  } catch {
    return {};
  }
}

function icon(name: string, attrs: Record<string, unknown> = {}): VNode {
  const UIcon = useUIComponent("UIcon");
  return h(UIcon, { name, "aria-hidden": "true", ...attrs });
}

const PANEL_MIN_WIDTH = 320;
const DETAILS_WIDTH = 280;
const LANE_MAX_WIDTH = 736;

/**
 * An agent session laid out like T3 Code: the timeline in the default slot, a details card that the header toggle
 * opens, and a right panel of `surfaces`. Each surface renders from the `surface-<id>` slot, else from `surface` with
 * `{ surface }`. A timeline that scrolls itself goes in `body` instead of the default slot. Give `storageKey` to keep the
 * panel, its width, its tabs and the details card as the user left them.
 */
export const AgentSession = defineComponent({
  name: "AgentSession",
  inheritAttrs: false,
  props: {
    title: { required: true, type: String },
    subtitle: { type: String },
    surfaces: { default: () => [], type: Array as PropType<AgentSessionSurface[]> },
    storageKey: { type: String },
    defaultPanelOpen: { default: false, type: Boolean },
    defaultDetailsOpen: { default: true, type: Boolean },
    defaultSurface: { type: String },
    defaultWidth: { default: 560, type: Number },
    surface: { type: String as PropType<string | null> },
    panelOpen: { default: undefined, type: Boolean },
    maximized: { default: undefined, type: Boolean },
  },
  emits: {
    "update:surface": (_id: string | null) => true,
    "update:panelOpen": (_open: boolean) => true,
    "update:maximized": (_maximized: boolean) => true,
  },
  setup(props, { attrs, emit, expose, slots }) {
    const stored = readLayout(props.storageKey);
    const known = (id: string | null | undefined) => props.surfaces.some((surface) => surface.id === id);
    const localPanelOpen = ref(stored.panelOpen ?? props.defaultPanelOpen);
    const panelOpen = computed({
      get: () => props.panelOpen ?? localPanelOpen.value,
      set: (open: boolean) => {
        if (open === (props.panelOpen ?? localPanelOpen.value)) return;
        if (props.panelOpen === undefined) localPanelOpen.value = open;
        emit("update:panelOpen", open);
      },
    });
    // Like T3 Code, the inline card keeps the user's choice, and the popover that replaces it on a narrow column starts
    // closed, so a remembered card never covers the timeline.
    const detailsOpen = ref(stored.detailsOpen ?? props.defaultDetailsOpen);
    const popoverOpen = ref(false);
    const localMaximized = ref(stored.maximized ?? false);
    const maximized = computed({
      get: () => props.maximized ?? localMaximized.value,
      set: (value: boolean) => {
        if (value === (props.maximized ?? localMaximized.value)) return;
        if (props.maximized === undefined) localMaximized.value = value;
        emit("update:maximized", value);
      },
    });
    const width = ref(stored.width ?? props.defaultWidth);
    const initialTabs = (stored.tabs ?? (props.defaultSurface ? [props.defaultSurface] : [])).filter(known);
    const tabs = ref<string[]>(initialTabs);
    const localActive = ref<string | null>(known(stored.active) ? stored.active ?? null : initialTabs[0] ?? null);
    const active = computed({
      get: () => props.surface !== undefined ? props.surface : localActive.value,
      set: (id: string | null) => {
        if (id === (props.surface !== undefined ? props.surface : localActive.value)) return;
        if (props.surface === undefined) localActive.value = id;
        emit("update:surface", id);
      },
    });
    // Keep the controlled surface's tab visible while a parent holds or delays a close request.
    const visibleTabs = computed(() => active.value && !tabs.value.includes(active.value) ? [...tabs.value, active.value] : tabs.value);
    if (active.value && !tabs.value.includes(active.value)) tabs.value.push(active.value);
    const root = ref<HTMLElement>();
    const body = ref<HTMLElement>();
    const bodyWidth = ref(0);
    const rootWidth = ref(0);
    const detailsInline = computed(() => bodyWidth.value >= LANE_MAX_WIDTH + DETAILS_WIDTH + 72);

    watch([panelOpen, detailsOpen, width, tabs, active, maximized], () => {
      if (!props.storageKey || typeof localStorage === "undefined") return;
      const value: StoredLayout = {
        panelOpen: panelOpen.value,
        detailsOpen: detailsOpen.value,
        width: width.value,
        tabs: visibleTabs.value,
        active: active.value,
        maximized: maximized.value,
      };
      localStorage.setItem(props.storageKey, JSON.stringify(value));
    }, { deep: true });
    watch([() => props.surface, () => props.surfaces], ([id]) => {
      if (id === undefined || (id !== null && !known(id))) return;
      if (id && !tabs.value.includes(id)) tabs.value = [...tabs.value, id];
    }, { immediate: true });

    let observer: ResizeObserver | undefined;
    onMounted(() => {
      observer = new ResizeObserver(() => {
        bodyWidth.value = body.value?.clientWidth ?? 0;
        rootWidth.value = root.value?.clientWidth ?? 0;
      });
      if (body.value) observer.observe(body.value);
      if (root.value) observer.observe(root.value);
      document.addEventListener("pointerdown", closeDetailsPopover);
      document.addEventListener("keydown", closeDetailsOnEscape);
    });
    onBeforeUnmount(() => {
      observer?.disconnect();
      document.removeEventListener("pointerdown", closeDetailsPopover);
      document.removeEventListener("keydown", closeDetailsOnEscape);
    });

    function closeDetailsOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !popoverOpen.value || detailsInline.value) return;
      popoverOpen.value = false;
      root.value?.querySelector<HTMLElement>("[data-slot='agent-session-details-toggle']")?.focus();
    }

    // The card floats over the timeline when the column is too narrow for it, and closes like a popover there.
    function closeDetailsPopover(event: PointerEvent) {
      if (!popoverOpen.value || detailsInline.value) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-slot='agent-session-details'], [data-slot='agent-session-details-toggle']")) return;
      popoverOpen.value = false;
    }

    function openSurface(id: string) {
      if (!tabs.value.includes(id)) tabs.value = [...tabs.value, id];
      active.value = id;
      panelOpen.value = true;
    }

    function closeSurface(id: string) {
      const index = visibleTabs.value.indexOf(id);
      tabs.value = visibleTabs.value.filter((tab) => tab !== id);
      if (active.value === id) active.value = tabs.value[Math.max(0, index - 1)] ?? null;
    }

    function togglePanel() {
      const open = !panelOpen.value;
      if (!open) maximized.value = false;
      panelOpen.value = open;
    }

    expose({ openSurface, closeSurface, togglePanel });

    function startResize(event: PointerEvent) {
      const handle = event.currentTarget as HTMLElement;
      const startX = event.clientX;
      const startWidth = width.value;
      handle.setPointerCapture(event.pointerId);
      const move = (next: PointerEvent) => {
        const max = Math.max(PANEL_MIN_WIDTH, rootWidth.value - 360);
        width.value = Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, startWidth + startX - next.clientX)));
      };
      const stop = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    }

    function resizeWithKeys(event: KeyboardEvent) {
      const step = event.shiftKey ? 64 : 16;
      if (event.key === "ArrowLeft") width.value += step;
      else if (event.key === "ArrowRight") width.value = Math.max(PANEL_MIN_WIDTH, width.value - step);
      else return;
      event.preventDefault();
    }

    function launcherKeys(event: KeyboardEvent) {
      const surface = props.surfaces.find((item) => item.shortcut?.toLowerCase() === event.key.toLowerCase());
      if (!surface) return;
      event.preventDefault();
      openSurface(surface.id);
    }

    const toggle = (options: {
      slot: string;
      label: string;
      iconName: string;
      pressed: boolean;
      onClick: () => void;
    }) =>
      h("button", {
        type: "button",
        class: "vh-agent-session__toggle",
        "data-slot": options.slot,
        "aria-label": options.label,
        "aria-pressed": options.pressed ? "true" : "false",
        title: options.label,
        onClick: options.onClick,
      }, [icon(options.iconName)]);

    const detailsToggle = () =>
      slots.details
        ? toggle({
            slot: "agent-session-details-toggle",
            label: "Session details",
            iconName: "i-lucide-square-menu",
            pressed: detailsInline.value ? detailsOpen.value : popoverOpen.value,
            onClick: () => {
              if (detailsInline.value) detailsOpen.value = !detailsOpen.value;
              else popoverOpen.value = !popoverOpen.value;
            },
          })
        : null;

    const panelToggle = () =>
      props.surfaces.length
        ? toggle({
            slot: "agent-session-panel-toggle",
            label: panelOpen.value ? "Close the right panel" : "Open the right panel",
            iconName: "i-lucide-panel-right",
            pressed: panelOpen.value,
            onClick: togglePanel,
          })
        : null;

    const launcher = () =>
      h("div", {
        class: "vh-agent-session__launcher",
        "data-slot": "agent-session-launcher",
        tabindex: 0,
        "aria-label": "Open a surface",
        onKeydown: launcherKeys,
      }, [
        h("div", { class: "vh-agent-session__launcher-inner" }, [
          h("h3", { class: "vh-agent-session__launcher-title" }, "Open a surface"),
          h("div", { class: "vh-agent-session__launcher-list" }, props.surfaces.map((surface) =>
            h("button", {
              type: "button",
              class: "vh-agent-session__launcher-item",
              onClick: () => openSurface(surface.id),
            }, [
              icon(surface.icon),
              h("span", { class: "vh-agent-session__launcher-label" }, surface.label),
              surface.shortcut ? h("kbd", { class: "vh-agent-session__kbd" }, surface.shortcut.toUpperCase()) : null,
            ]))),
        ]),
      ]);

    const panel = () => {
      const surfaceById = new Map(props.surfaces.map((surface) => [surface.id, surface]));
      const current = active.value ? surfaceById.get(active.value) : undefined;
      return h(TabsRoot, {
        as: "aside",
        modelValue: active.value ?? "",
        "onUpdate:modelValue": (id: string | number) => { active.value = String(id); },
        class: "vh-agent-session__panel",
        "data-slot": "agent-session-panel",
        "aria-label": "Right panel",
      }, () => [
        h("div", { class: "vh-agent-session__panel-header", "data-slot": "agent-session-panel-header" }, [
          // Reka keeps the close button beside its trigger and owns keyboard focus and tab semantics.
          h(TabsList, { class: "vh-agent-session__tabs" }, () => [
            ...visibleTabs.value.map((id) => {
              const surface = surfaceById.get(id);
              if (!surface) return null;
              const selected = id === active.value;
              // A lone tab has nothing to close into: the panel toggle hides the panel.
              const closable = visibleTabs.value.length > 1;
              return h("div", {
                key: id,
                class: "vh-agent-session__tab",
                "data-active": selected ? "" : undefined,
                "data-closable": closable ? "" : undefined,
              }, [
                h(TabsTrigger, {
                  value: id,
                  class: "vh-agent-session__tab-button",
                  onAuxclick: (event: MouseEvent) => closable && event.button === 1 && closeSurface(id),
                }, () => [icon(surface.icon, { class: "vh-agent-session__tab-icon" }), h("span", surface.label)]),
                closable
                  ? h("button", {
                      type: "button",
                      class: "vh-agent-session__tab-close",
                      "aria-label": `Close ${surface.label}`,
                      onClick: () => closeSurface(id),
                    }, [icon("i-lucide-x")])
                  : null,
              ]);
            }),
            h("button", {
              type: "button",
              class: "vh-agent-session__toggle vh-agent-session__new-tab",
              "aria-label": "Open a surface",
              title: "Open a surface",
              "aria-pressed": active.value === null ? "true" : "false",
              onClick: () => (active.value = null),
            }, [icon("i-lucide-plus")]),
          ]),
          h("div", { class: "vh-agent-session__controls" }, [
            toggle({
              slot: "agent-session-maximize",
              label: maximized.value ? "Restore panel size" : "Maximize panel",
              iconName: maximized.value ? "i-lucide-minimize-2" : "i-lucide-maximize-2",
              pressed: maximized.value,
              onClick: () => (maximized.value = !maximized.value),
            }),
            panelToggle(),
          ]),
        ]),
        current
          ? h(TabsContent, {
              key: current.id,
              value: current.id,
              class: "vh-agent-session__panel-body",
              "data-slot": "agent-session-panel-body",
            }, () => slots[`surface-${current.id}`]?.({ surface: current }) ?? slots.surface?.({ surface: current }))
          : h("div", { class: "vh-agent-session__panel-body", "data-slot": "agent-session-panel-body" }, [launcher()]),
      ]);
    };

    return () => {
      const open = panelOpen.value && props.surfaces.length > 0;
      const showDetails = Boolean(slots.details) && (detailsInline.value ? detailsOpen.value : popoverOpen.value);
      return h("section", {
        ...attrs,
        ref: root,
        class: ["vh-agent-session", attrs.class],
        "aria-label": attrs["aria-label"] ?? props.title,
        "data-panel-open": open ? "" : undefined,
        "data-maximized": open && maximized.value ? "" : undefined,
        "data-details": showDetails ? (detailsInline.value ? "inline" : "popover") : undefined,
        style: [{ "--vh-agent-panel-width": `${width.value}px` }, attrs.style],
      }, [
        h("div", { class: "vh-agent-session__main", "data-slot": "agent-session-main" }, [
          h("header", { class: "vh-agent-session__header", "data-slot": "agent-session-header" }, [
            h("div", { class: "vh-agent-session__heading" }, slots.heading?.() ?? [
              h("h2", { class: "vh-agent-session__title" }, props.title),
              props.subtitle ? h("span", { class: "vh-agent-session__subtitle" }, props.subtitle) : null,
            ]),
            h("div", { class: "vh-agent-session__controls" }, [
              slots.actions?.(),
              detailsToggle(),
              open ? null : panelToggle(),
            ]),
          ]),
          h("div", { ref: body, class: "vh-agent-session__body", "data-slot": "agent-session-body" }, [
            // `body` replaces the scroller and its lane, for a timeline that scrolls itself. It reads
            // `--vh-agent-session-inset-end` to stay clear of an inline details card.
            slots.body?.() ?? h("div", { class: "vh-agent-session__scroll", "data-slot": "agent-session-scroll" }, [
              h("div", { class: "vh-agent-session__lane", "data-slot": "agent-session-lane" }, slots.default?.()),
            ]),
            showDetails
              ? h("aside", {
                  class: "vh-agent-session__details",
                  "data-slot": "agent-session-details",
                  "aria-label": "Session details",
                }, [h("div", { class: "vh-agent-session__details-card" }, slots.details?.())])
              : null,
          ]),
        ]),
        open
          ? h("div", {
              class: "vh-agent-session__resizer",
              "data-slot": "agent-session-resizer",
              role: "separator",
              tabindex: 0,
              "aria-orientation": "vertical",
              "aria-label": "Resize the right panel",
              "aria-valuenow": width.value,
              onPointerdown: startResize,
              onKeydown: resizeWithKeys,
              onDblclick: () => (width.value = props.defaultWidth),
            })
          : null,
        open ? panel() : null,
      ]);
    };
  },
});

/** One section of the details card, with a small muted heading. */
export const AgentSessionDetailsSection = defineComponent({
  name: "AgentSessionDetailsSection",
  props: { title: { type: String } },
  setup(props, { slots }) {
    return () =>
      h("section", { class: "vh-agent-session__section", "data-slot": "agent-session-details-section" }, [
        props.title || slots.actions
          ? h("div", { class: "vh-agent-session__section-heading" }, [
              props.title ? h("h3", props.title) : null,
              slots.actions ? h("div", { class: "vh-agent-session__section-actions" }, slots.actions()) : null,
            ])
          : null,
        h("div", { class: "vh-agent-session__section-rows" }, slots.default?.()),
      ]);
  },
});

/** A 32px row of the details card: an icon, a label, and a value at the end. A row with `href` or `onClick` is a control. */
export const AgentSessionDetailsRow = defineComponent({
  name: "AgentSessionDetailsRow",
  inheritAttrs: false,
  props: {
    icon: { type: String },
    label: { type: String },
    value: { type: [String, Number] },
    href: { type: String },
    tone: { default: "default", type: String as PropType<"default" | "muted" | "success" | "error" | "info"> },
    title: { type: String },
  },
  setup(props, { attrs, slots }) {
    return () => {
      const interactive = Boolean(props.href || attrs.onClick);
      const tag = props.href ? "a" : interactive ? "button" : "div";
      return h(tag, {
        ...attrs,
        class: ["vh-agent-session__row", attrs.class],
        "data-slot": "agent-session-details-row",
        "data-interactive": interactive ? "" : undefined,
        "data-tone": props.tone === "default" ? undefined : props.tone,
        href: props.href,
        type: tag === "button" ? "button" : undefined,
        title: props.title,
      }, [
        props.icon ? icon(props.icon, { class: "vh-agent-session__row-icon" }) : slots.icon?.(),
        h("span", { class: "vh-agent-session__row-label" }, slots.default?.() ?? props.label),
        props.value !== undefined || slots.value
          ? h("span", { class: "vh-agent-session__row-value" }, slots.value?.() ?? String(props.value))
          : null,
      ]);
    };
  },
});

function workRow(entry: AgentSessionWorkEntry, open: boolean, onToggle: () => void): VNode {
  const expandable = Boolean(entry.detail);
  const line = [
    h("span", { class: "vh-agent-session__work-icon", "data-status": entry.status }, [
      icon(entry.status === "error" ? "i-lucide-circle-x" : workIcons[entry.kind]),
    ]),
    h("span", { class: "vh-agent-session__work-label" }, [
      h("span", { class: "vh-agent-session__work-title" }, entry.label),
      entry.preview ? h("span", { class: "vh-agent-session__work-preview" }, entry.preview) : null,
    ]),
    entry.trailing ? h("span", { class: "vh-agent-session__work-trailing" }, entry.trailing) : null,
  ];
  return h("div", {
    key: entry.id,
    class: "vh-agent-session__work-row",
    "data-slot": "agent-session-work-row",
    "data-kind": entry.kind,
    "data-open": open ? "" : undefined,
  }, [
    expandable
      ? h("button", { type: "button", class: "vh-agent-session__work-line", "aria-expanded": open ? "true" : "false", onClick: onToggle }, line)
      : h("div", { class: "vh-agent-session__work-line" }, line),
    expandable && open ? h("pre", { class: "vh-agent-session__work-detail" }, entry.detail) : null,
  ]);
}

/** A group of tool calls, folded behind one line such as "Worked for 3m 12s". */
export const AgentSessionWorkGroup = defineComponent({
  name: "AgentSessionWorkGroup",
  props: {
    label: { type: String },
    entries: { required: true, type: Array as PropType<AgentSessionWorkEntry[]> },
    defaultOpen: { default: false, type: Boolean },
  },
  setup(props) {
    const open = ref(props.defaultOpen);
    const openRows = ref(new Set<string>());
    const toggleRow = (id: string) => {
      const next = new Set(openRows.value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      openRows.value = next;
    };
    return () => {
      const failed = props.entries.filter((entry) => entry.status === "error").length;
      const summary = props.label ?? `${props.entries.length} ${props.entries.length === 1 ? "step" : "steps"}`;
      return h("div", { class: "vh-agent-session__work", "data-slot": "agent-session-work", "data-open": open.value ? "" : undefined }, [
        h("button", {
          type: "button",
          class: "vh-agent-session__work-summary",
          "aria-expanded": open.value ? "true" : "false",
          onClick: () => (open.value = !open.value),
        }, [
          h("span", summary),
          props.label ? h("span", { class: "vh-agent-session__work-count" }, `${props.entries.length} ${props.entries.length === 1 ? "step" : "steps"}`) : null,
          failed ? h("span", { class: "vh-agent-session__work-failed" }, `${failed} failed`) : null,
          icon("i-lucide-chevron-down", { class: "vh-agent-session__work-chevron" }),
        ]),
        open.value
          ? h("div", { class: "vh-agent-session__work-list" }, props.entries.map((entry) =>
              workRow(entry, openRows.value.has(entry.id), () => toggleRow(entry.id))))
          : null,
      ]);
    };
  },
});

const FOLD_LINES = 14;
const FOLD_CHARACTERS = 900;

// A long prompt folds to its first lines, like T3 Code folds long user turns, so the answer stays in view.
const UserMessage = defineComponent({
  name: "AgentSessionUserMessage",
  props: { text: { required: true, type: String } },
  setup(props) {
    const expanded = ref(false);
    return () => {
      const long = props.text.length > FOLD_CHARACTERS || props.text.split("\n").length > FOLD_LINES;
      const folded = long && !expanded.value;
      return h("div", { class: "vh-agent-session__user", "data-slot": "agent-session-user" }, [
        h("h3", { class: "vh-agent-session__sr" }, "You"),
        h("div", { class: "vh-agent-session__bubble", "data-folded": folded ? "" : undefined }, [
          h("div", { class: "vh-agent-session__bubble-text" }, props.text),
          long
            ? h("button", {
                type: "button",
                class: "vh-agent-session__bubble-more",
                "aria-expanded": expanded.value ? "true" : "false",
                onClick: () => (expanded.value = !expanded.value),
              }, expanded.value ? "Show less" : "Show more")
            : null,
        ]),
      ]);
    };
  },
});

/** The session's turns: user bubbles on the right, the agent's answers as Markdown, and folded tool calls between them. */
export const AgentSessionTimeline = defineComponent({
  name: "AgentSessionTimeline",
  props: {
    items: { required: true, type: Array as PropType<AgentSessionItem[]> },
  },
  setup(props, { slots }) {
    return () =>
      h("div", { class: "vh-agent-session__timeline", "data-slot": "agent-session-timeline" }, props.items.map((item) => {
        const custom = slots[`item-${item.type}`]?.({ item });
        if (custom) return h("div", { key: item.id, class: "vh-agent-session__item" }, custom);
        if (item.type === "user") return h(UserMessage, { key: item.id, text: item.text });
        if (item.type === "assistant") {
          return h("div", { key: item.id, class: "vh-agent-session__assistant", "data-slot": "agent-session-assistant" }, [
            h(Markdown, { value: item.text }),
          ]);
        }
        if (item.type === "divider") {
          return h("div", { key: item.id, class: "vh-agent-session__divider", role: "separator" }, item.label);
        }
        return h(AgentSessionWorkGroup, {
          key: item.id,
          label: item.label,
          entries: item.entries,
          defaultOpen: item.defaultOpen,
        });
      }));
  },
});
