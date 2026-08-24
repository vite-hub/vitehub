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

const invocationListRowSize = 86;
const invocationListRowWithDescriptionSize = 106;

function rowSize(item: AgentInvocationListItem): number {
  return item.description ? invocationListRowWithDescriptionSize : invocationListRowSize;
}

function rowIndexAtOffset(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = offsets.length - 2;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (offset < offsets[middle]!) high = middle - 1;
    else if (offset >= offsets[middle + 1]!) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(low, offsets.length - 2));
}

function relativeTime(value: string | undefined, now: number | undefined): string | undefined {
  if (!value || now === undefined) return;
  const elapsed = now - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return;
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(value));
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
  itemProps?: Record<string, unknown>,
) {
  const time = relativeTime(item.status === "running" ? item.startedAt ?? item.updatedAt : item.updatedAt, now);
  const harness = harnessSlot?.({ item }) ?? [
    item.provider ? h("span", { title: `Provider: ${item.provider}` }, [metadataIcon("provider"), h("span", { class: "vh-visually-hidden" }, `Provider ${item.provider}`)]) : null,
    item.agent ? h("span", { title: `Agent: ${item.agent}` }, [metadataIcon("agent"), h("span", { class: "vh-visually-hidden" }, `Agent ${item.agent}`)]) : null,
  ];
  return h("li", { key: item.id, ...itemProps }, [
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
    hasMore: Boolean,
    items: { required: true, type: Array as PropType<readonly AgentInvocationListItem[]> },
    loading: Boolean,
    now: Number,
    retryKey: [Number, String],
    selectedId: String,
    virtual: { default: true, type: Boolean },
  },
  emits: {
    endReached: () => true,
    select: (_item: AgentInvocationListItem) => true,
  },
  setup(props, { emit, slots }) {
    const viewport = ref<HTMLElement | null>(null);
    const list = ref<HTMLElement | null>(null);
    const mounted = ref(false);
    const listOffset = computed(() => list.value?.offsetTop ?? 0);
    const requestedLength = ref<number>();
    const scrollRevision = ref(0);
    const scrollTop = ref(0);
    const viewportHeight = ref(0);
    const overscan = 6;
    let resizeObserver: ResizeObserver | undefined;
    let measureViewport: (() => void) | undefined;
    const rowOffsets = computed(() => {
      const offsets = [0];
      for (const item of props.items) offsets.push(offsets.at(-1)! + rowSize(item));
      return offsets;
    });
    const virtualRows = computed(() => {
      if (!props.items.length) return [];
      const offsets = rowOffsets.value;
      const listScrollTop = Math.max(0, scrollTop.value - listOffset.value);
      const firstVisible = rowIndexAtOffset(offsets, listScrollTop);
      const lastVisible = rowIndexAtOffset(offsets, listScrollTop + Math.max(0, viewportHeight.value - 1));
      const start = Math.max(0, firstVisible - overscan);
      const end = Math.min(props.items.length, lastVisible + overscan + 1);
      return Array.from({ length: end - start }, (_, offset) => {
        const index = start + offset;
        return { index, size: offsets[index + 1]! - offsets[index]!, start: offsets[index]! };
      });
    });
    watch(
      [virtualRows, () => props.hasMore, () => props.loading, () => props.items.length, scrollRevision],
      ([rows, hasMore, loading, length]) => {
        if (!hasMore || loading || !length || requestedLength.value === length) return;
        if (rows.at(-1)?.index !== undefined && rows.at(-1)!.index >= length - 6) {
          requestedLength.value = length;
          emit("endReached");
        }
      },
      { flush: "post" },
    );
    watch(() => props.items.length, (length, previous) => {
      if (length < previous) requestedLength.value = undefined;
    });
    watch(() => props.retryKey, () => {
      requestedLength.value = undefined;
      scrollRevision.value++;
    });
    onMounted(() => {
      mounted.value = true;
      if (!viewport.value) return;
      measureViewport = () => { viewportHeight.value = viewport.value?.clientHeight ?? 0; };
      measureViewport();
      if ("ResizeObserver" in globalThis) {
        resizeObserver = new ResizeObserver(measureViewport);
        resizeObserver.observe(viewport.value);
      } else {
        window.addEventListener("resize", measureViewport);
      }
    });
    onBeforeUnmount(() => {
      resizeObserver?.disconnect();
      if (measureViewport) window.removeEventListener("resize", measureViewport);
    });
    const select = (item: AgentInvocationListItem) => emit("select", item);

    return () => h("nav", {
      "aria-label": props.ariaLabel,
      class: "vh-invocation-list",
      onScroll: (event: Event) => {
        scrollTop.value = (event.currentTarget as HTMLElement).scrollTop;
        scrollRevision.value++;
      },
      ref: viewport,
    }, [
      slots.header?.({ items: props.items }),
      props.items.length === 0
        ? slots.empty?.() ?? h("p", { class: "vh-invocation-list__empty" }, "No sessions yet.")
        : null,
      props.items.length && props.virtual && mounted.value
        ? h("ul", {
            class: "vh-invocation-list__virtual",
            ref: list,
            style: { height: `${rowOffsets.value.at(-1)}px` },
          }, virtualRows.value.map(row => renderItem(
            props.items[row.index]!,
            props.selectedId,
            props.now,
            select,
            slots.projectIcon,
            slots.harness,
            {
              "data-index": row.index,
              style: { height: `${row.size}px`, transform: `translateY(${row.start}px)` },
            },
          )))
        : props.items.length
          ? h("ul", props.items.map(item => renderItem(item, props.selectedId, props.now, select, slots.projectIcon, slots.harness)))
          : null,
      props.loading && props.items.length ? slots.loading?.() ?? h("p", { class: "vh-invocation-list__loading" }, "Loading sessions…") : null,
      slots.footer?.({ items: props.items }),
    ]);
  },
});
