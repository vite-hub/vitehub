import { computed, defineComponent, h, ref, type PropType, type Slot, watch } from "vue";
import type { AgentInvocationListItem, AgentInvocationStatus } from "../types.ts";

function statusLabel(status: AgentInvocationStatus): string {
  return {
    cancelled: "Cancelled",
    completed: "Done",
    failed: "Failed",
    pending: "Queued",
    running: "Working",
  }[status];
}

function relativeTime(value: string | undefined, now: number | undefined): string | undefined {
  if (!value || now === undefined) return;
  const elapsed = now - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return;
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(value));
}

function folderIcon() {
  return h("svg", { "aria-hidden": "true", fill: "none", viewBox: "0 0 24 24" }, [
    h("path", { d: "M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "stroke-linecap": "round", "stroke-linejoin": "round" }),
  ]);
}

function statusIcon(status: AgentInvocationStatus) {
  const paths: Record<AgentInvocationStatus, readonly string[]> = {
    cancelled: ["M7 7l10 10", "M17 7 7 17", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
    completed: ["m8 12 2.5 2.5L16 9", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
    failed: ["m9 9 6 6", "m15 9-6 6", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
    pending: ["M12 7v5l3 2", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
    running: ["M21 12a9 9 0 0 1-9 9", "M3 12a9 9 0 0 1 9-9"],
  };
  return h("svg", { "aria-hidden": "true", fill: "none", viewBox: "0 0 24 24" }, paths[status].map(path => h("path", {
    d: path,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  })));
}

function metadataIcon(kind: "agent" | "provider") {
  return h("svg", { "aria-hidden": "true", fill: "none", viewBox: "0 0 24 24" }, kind === "agent"
    ? [h("path", { d: "M4 8h16v10H4z" }), h("path", { d: "M12 8V4M8 12h.01M16 12h.01" })]
    : [h("path", { d: "M5 7h14M5 12h14M5 17h14" }), h("path", { d: "M7 5v4M17 10v4M10 15v4" })]);
}

function renderItem(
  item: AgentInvocationListItem,
  selectedId: string | undefined,
  now: number | undefined,
  select: (item: AgentInvocationListItem) => void,
  projectIconSlot?: Slot,
  harnessSlot?: Slot,
) {
  const time = relativeTime(item.status === "running" ? item.startedAt ?? item.updatedAt : item.updatedAt, now);
  const harness = harnessSlot?.({ item }) ?? [
    item.provider ? h("span", { title: `Provider: ${item.provider}` }, [metadataIcon("provider"), h("span", { class: "vh-visually-hidden" }, `Provider ${item.provider}`)]) : null,
    item.agent ? h("span", { title: `Agent: ${item.agent}` }, [metadataIcon("agent"), h("span", { class: "vh-visually-hidden" }, `Agent ${item.agent}`)]) : null,
  ];
  return h("li", { key: item.id }, [
    h("button", {
      "aria-current": selectedId === item.id ? "true" : undefined,
      class: "vh-invocation-list__item",
      "data-relative-time": time,
      "data-status": item.status,
      onClick: () => select(item),
      type: "button",
    }, [
      h("span", { class: "vh-invocation-list__context" }, [
        h("span", { class: "vh-invocation-list__project-icon" }, projectIconSlot?.({ item }) ?? [folderIcon()]),
        h("span", { class: "vh-invocation-list__project" }, item.project ?? "Project"),
        h("span", { class: "vh-invocation-list__state" }, [
          h("span", { class: "vh-invocation-list__state-icon" }, [statusIcon(item.status)]),
          h("span", statusLabel(item.status)),
          time ? h("time", { datetime: item.updatedAt }, time) : null,
        ]),
      ]),
      h("strong", { class: "vh-invocation-list__title" }, item.title),
      item.context || item.agent || item.provider
        ? h("span", { class: "vh-invocation-list__meta" }, [
            item.context ? h("span", { class: "vh-invocation-list__branch" }, item.context) : null,
            h("span", { class: "vh-invocation-list__harness" }, harness),
          ])
        : null,
      item.description ? h("span", { class: "vh-invocation-list__description" }, item.description) : null,
    ]),
  ]);
}

export const AgentInvocationList = defineComponent({
  name: "AgentInvocationList",
  props: {
    ariaLabel: { default: "Agent sessions", type: String },
    items: { required: true, type: Array as PropType<readonly AgentInvocationListItem[]> },
    now: Number,
    selectedId: String,
  },
  emits: {
    select: (_item: AgentInvocationListItem) => true,
  },
  setup(props, { emit, slots }) {
    const settledOpen = ref(false);
    const active = computed(() => props.items.filter(item => item.status === "pending" || item.status === "running"));
    const settled = computed(() => props.items.filter(item => item.status !== "pending" && item.status !== "running"));
    watch(() => props.selectedId, (id) => {
      if (id && settled.value.some(item => item.id === id)) settledOpen.value = true;
    }, { immediate: true });
    const select = (item: AgentInvocationListItem) => emit("select", item);

    return () => h("nav", { "aria-label": props.ariaLabel, class: "vh-invocation-list" }, [
      slots.header?.({ active: active.value, settled: settled.value }),
      props.items.length === 0
        ? slots.empty?.() ?? h("p", { class: "vh-invocation-list__empty" }, "No sessions yet.")
        : null,
      active.value.length
        ? h("section", { "aria-label": "Active sessions" }, [
            h("h2", { class: "vh-invocation-list__section-title" }, "Active"),
            h("ul", active.value.map(item => renderItem(item, props.selectedId, props.now, select, slots.projectIcon, slots.harness))),
          ])
        : null,
      settled.value.length
        ? h("section", { class: "vh-invocation-list__settled" }, [
            h("button", {
              "aria-expanded": settledOpen.value,
              class: "vh-invocation-list__settled-trigger",
              onClick: () => { settledOpen.value = !settledOpen.value; },
              type: "button",
            }, [h("span", `Settled (${settled.value.length})`), h("span", { "aria-hidden": "true" }, "⌄")]),
            settledOpen.value ? h("ul", settled.value.map(item => renderItem(item, props.selectedId, props.now, select, slots.projectIcon, slots.harness))) : null,
          ])
        : null,
      slots.footer?.({ active: active.value, settled: settled.value }),
    ]);
  },
});
