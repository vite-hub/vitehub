import { defineComponent, h, onBeforeUnmount, onMounted, ref, type PropType, type Slot, watch } from "vue";
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

interface RelativeTime {
  label: string;
  short: string;
}

const invocationListPaginationThreshold = 6 * 106;

function relativeTime(value: string | undefined, now: number | undefined): RelativeTime | undefined {
  if (!value || now === undefined) return;
  const elapsed = now - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return;
  if (elapsed < 60_000) return { label: "now", short: "now" };
  if (elapsed < 3_600_000) {
    const minutes = Math.floor(elapsed / 60_000);
    return { label: new Intl.RelativeTimeFormat("en").format(-minutes, "minute"), short: `${minutes}m` };
  }
  if (elapsed < 86_400_000) {
    const hours = Math.floor(elapsed / 3_600_000);
    return { label: new Intl.RelativeTimeFormat("en").format(-hours, "hour"), short: `${hours}h` };
  }
  const date = new Date(value);
  return {
    label: new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date),
    short: new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" }).format(date),
  };
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
    running: ["M21 12a9 9 0 1 1-6.219-8.56"],
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
  const timestamp = item.status === "running" ? item.startedAt ?? item.updatedAt : item.updatedAt;
  const time = relativeTime(timestamp, now);
  const harness = harnessSlot?.({ item }) ?? [
    item.provider ? h("span", { title: `Provider: ${item.provider}` }, [metadataIcon("provider"), h("span", { class: "vh-visually-hidden" }, `Provider ${item.provider}`)]) : null,
    item.agent ? h("span", { title: `Agent: ${item.agent}` }, [metadataIcon("agent"), h("span", { class: "vh-visually-hidden" }, `Agent ${item.agent}`)]) : null,
  ];
  return h("li", { key: item.id }, [
    h("button", {
      "aria-current": selectedId === item.id ? "true" : undefined,
      class: "vh-invocation-list__item",
      "data-relative-time": time?.short,
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
          time ? h("time", { "aria-label": time.label, datetime: timestamp, title: time.label }, time.short) : null,
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
    hasMore: Boolean,
    items: { required: true, type: Array as PropType<readonly AgentInvocationListItem[]> },
    loading: Boolean,
    now: Number,
    retryKey: [Number, String],
    selectedId: String,
  },
  emits: {
    endReached: () => true,
    select: (_item: AgentInvocationListItem) => true,
  },
  setup(props, { emit, slots }) {
    const viewport = ref<HTMLElement | null>(null);
    const requestedLength = ref<number>();
    let resizeObserver: ResizeObserver | undefined;
    const requestMoreIfNeeded = () => {
      const element = viewport.value;
      const length = props.items.length;
      if (!element || element.clientHeight <= 0 || !props.hasMore || props.loading || !length || requestedLength.value === length) return;
      if (element.scrollTop + element.clientHeight >= element.scrollHeight - invocationListPaginationThreshold) {
        requestedLength.value = length;
        emit("endReached");
      }
    };
    watch([() => props.items.length, () => props.hasMore, () => props.loading], ([length], [previous]) => {
      if (length < previous) requestedLength.value = undefined;
      requestMoreIfNeeded();
    }, { flush: "post" });
    watch(() => props.retryKey, () => {
      requestedLength.value = undefined;
      requestMoreIfNeeded();
    });
    onMounted(() => {
      requestMoreIfNeeded();
      if ("ResizeObserver" in globalThis && viewport.value) {
        resizeObserver = new ResizeObserver(requestMoreIfNeeded);
        resizeObserver.observe(viewport.value);
      }
    });
    onBeforeUnmount(() => resizeObserver?.disconnect());
    const select = (item: AgentInvocationListItem) => emit("select", item);

    return () => h("nav", {
      "aria-label": props.ariaLabel,
      "aria-busy": props.loading ? "true" : undefined,
      class: "vh-invocation-list",
      onScroll: requestMoreIfNeeded,
      ref: viewport,
    }, [
      slots.header?.({ items: props.items }),
      props.items.length === 0
        ? slots.empty?.() ?? h("p", { class: "vh-invocation-list__empty" }, "No sessions yet.")
        : null,
      props.items.length
        ? h("ul", props.items.map(item => renderItem(item, props.selectedId, props.now, select, slots.projectIcon, slots.harness)))
        : null,
      props.loading && props.items.length ? slots.loading?.() ?? h("p", { class: "vh-invocation-list__loading", role: "status" }, "Loading sessions…") : null,
      slots.footer?.({ items: props.items }),
    ]);
  },
});
