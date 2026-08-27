import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref, type PropType, type Slot, watch } from "vue";
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

const invocationStatusPriority: Record<AgentInvocationStatus, number> = {
  running: 0,
  pending: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
};

function invocationUpdatedAt(item: AgentInvocationListItem): number {
  const timestamp = Date.parse(item.updatedAt ?? item.startedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortInvocationItems(items: readonly AgentInvocationListItem[]): AgentInvocationListItem[] {
  return [...items].sort((left, right) => invocationStatusPriority[left.status] - invocationStatusPriority[right.status]
    || invocationUpdatedAt(right) - invocationUpdatedAt(left));
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
    const automaticallyRequestedVisibleLength = ref<number>();
    const queuedOpen = ref(true);
    const doneOpen = ref(props.items.some(item => item.id === props.selectedId
      && item.status !== "running"
      && item.status !== "pending"));
    const groups = computed(() => {
      const sorted = sortInvocationItems(props.items);
      return [
        { collapsible: false, items: sorted.filter(item => item.status === "running"), key: "working", label: "Working" },
        { collapsible: true, defaultOpen: true, items: sorted.filter(item => item.status === "pending"), key: "queued", label: "Queued" },
        { collapsible: true, defaultOpen: false, items: sorted.filter(item => item.status !== "running" && item.status !== "pending"), key: "done", label: "Done" },
      ].filter(group => group.items.length > 0);
    });
    const visibleLength = computed(() => props.items.filter((item) => {
      if (item.status === "running") return true;
      if (item.status === "pending") return queuedOpen.value;
      return doneOpen.value;
    }).length);
    let resizeObserver: ResizeObserver | undefined;
    const requestMoreIfNeeded = () => {
      const element = viewport.value;
      const length = props.items.length;
      if (!element || element.clientHeight <= 0 || !props.hasMore || props.loading || !length || requestedLength.value === length) return false;
      if (element.scrollTop + element.clientHeight >= element.scrollHeight - invocationListPaginationThreshold) {
        requestedLength.value = length;
        emit("endReached");
        return true;
      }
      return false;
    };
    const requestMoreAutomatically = () => {
      const hasCollapsedGroup = Boolean(viewport.value?.querySelector("details:not([open])"));
      if (hasCollapsedGroup && (!visibleLength.value || automaticallyRequestedVisibleLength.value === visibleLength.value)) return;
      if (requestMoreIfNeeded()) automaticallyRequestedVisibleLength.value = visibleLength.value;
    };
    watch([() => props.items.length, visibleLength, () => props.hasMore, () => props.loading], ([length, visible], [previous, previousVisible]) => {
      if (length < previous || visible < previousVisible) requestedLength.value = undefined;
      requestMoreAutomatically();
    }, { flush: "post" });
    watch(() => props.retryKey, () => {
      requestedLength.value = undefined;
      requestMoreIfNeeded();
    });
    watch([
      () => props.selectedId,
      () => props.items.find(item => item.id === props.selectedId)?.status,
    ], ([selectedId, status], [previousSelectedId, previousStatus]) => {
      if ((selectedId === previousSelectedId && status === previousStatus) || status === undefined || status === "running") return;
      if (status === "pending") queuedOpen.value = true;
      else doneOpen.value = true;
    });
    onMounted(() => {
      requestMoreAutomatically();
      if ("ResizeObserver" in globalThis && viewport.value) {
        resizeObserver = new ResizeObserver(requestMoreAutomatically);
        resizeObserver.observe(viewport.value);
      }
    });
    onBeforeUnmount(() => resizeObserver?.disconnect());
    const select = (item: AgentInvocationListItem) => emit("select", item);
    const renderRows = (group: (typeof groups.value)[number]) => h("ul", {
      class: "vh-invocation-list__group-items",
      "data-group": group.key,
    }, group.items.map(item => renderItem(item, props.selectedId, props.now, select, slots.projectIcon, slots.harness)));
    const renderGroupHeading = (group: (typeof groups.value)[number]) => [
      h("span", { class: "vh-invocation-list__group-label" }, group.label),
      h("span", {
        "aria-label": `${group.items.length} ${group.items.length === 1 ? "session" : "sessions"}`,
        class: "vh-invocation-list__group-count",
      }, String(group.items.length)),
    ];
    const renderGroup = (group: (typeof groups.value)[number]) => group.collapsible
      ? h("details", {
          class: "vh-invocation-list__group vh-invocation-list__group--collapsible",
          "data-group": group.key,
          key: group.key,
          onToggle: (event: Event) => {
            if (!(event.currentTarget instanceof HTMLDetailsElement)) return;
            if (group.key === "queued") queuedOpen.value = event.currentTarget.open;
            else doneOpen.value = event.currentTarget.open;
            if (event.currentTarget.open) requestMoreIfNeeded();
          },
          open: group.key === "queued" ? queuedOpen.value : doneOpen.value,
        }, [h("summary", { class: "vh-invocation-list__group-heading" }, renderGroupHeading(group)), renderRows(group)])
      : h("section", {
          class: "vh-invocation-list__group vh-invocation-list__group--static",
          "data-group": group.key,
          key: group.key,
        }, [h("header", { class: "vh-invocation-list__group-heading" }, renderGroupHeading(group)), renderRows(group)]);

    return () => h("nav", {
      "aria-label": props.ariaLabel,
      class: "vh-invocation-list",
      onScroll: requestMoreIfNeeded,
      ref: viewport,
    }, [
      slots.header?.({ items: props.items }),
      props.items.length === 0
        ? slots.empty?.() ?? h("p", { class: "vh-invocation-list__empty" }, "No sessions yet.")
        : null,
      props.items.length
        ? h("div", { "aria-busy": props.loading ? "true" : undefined, class: "vh-invocation-list__groups" }, groups.value.map(renderGroup))
        : null,
      props.loading && props.items.length ? slots.loading?.() ?? h("p", { class: "vh-invocation-list__loading", role: "status" }, "Loading sessions…") : null,
      slots.footer?.({ items: props.items }),
    ]);
  },
});
