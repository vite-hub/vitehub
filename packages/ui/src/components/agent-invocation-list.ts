import { channelIcon } from "../internal/channel-icon.ts";
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, type PropType, watch } from "vue";
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

function renderItem(
  item: AgentInvocationListItem,
  selectedId: string | undefined,
  now: number | undefined,
  select: (item: AgentInvocationListItem) => void,
) {
  const timestamp = item.status === "running" ? item.startedAt ?? item.updatedAt : item.updatedAt;
  const time = relativeTime(timestamp, now);
  return h("li", { key: item.id }, [
    h("button", {
      "aria-current": selectedId === item.id ? "true" : undefined,
      class: "vh-invocation-list__item",
      "data-invocation-id": item.id,
      "data-relative-time": time?.short,
      "data-status": item.status,
      onClick: () => select(item),
      type: "button",
    }, [
      h("strong", { class: "vh-invocation-list__title", title: item.title }, item.title),
      h("span", { class: "vh-invocation-list__meta" }, [
        item.context ? h("span", { class: "vh-invocation-list__branch" }, item.context) : null,
        h("span", { class: "vh-invocation-list__state", title: item.description }, [
          item.status === "completed" ? null : h("span", { class: "vh-invocation-list__state-icon" }, [statusIcon(item.status)]),
          item.status === "completed" ? null : h("span", statusLabel(item.status)),
          time ? h("time", { "aria-label": time.label, datetime: timestamp, title: time.label }, time.short) : null,
        ]),
        item.channel ? channelIcon(item.channel) : null,
      ]),
    ]),
  ]);
}

export const AgentInvocationList = defineComponent({
  name: "AgentInvocationList",
  props: {
    ariaLabel: { default: "Agent sessions", type: String },
    continuationKey: [Number, String],
    hasMore: Boolean,
    remainingStatuses: { default: () => [], type: Array as PropType<readonly AgentInvocationStatus[]> },
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
    let focusedItemBeforeUpdate: { element: HTMLButtonElement; id: string; status: string | undefined } | undefined;
    const paginationKey = computed(() => props.items.map(item => `${item.id}:${item.status}`).join("\0"));
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
    const requestMoreAutomatically = () => requestMoreIfNeeded();
    const requestMoreOnScroll = () => requestMoreIfNeeded();
    watch([() => props.items.length, paginationKey, () => props.hasMore, () => props.loading], ([length, key], [previous, previousKey]) => {
      if (length < previous || (length === previous && key !== previousKey)) requestedLength.value = undefined;
      requestMoreAutomatically();
    }, { flush: "post" });
    watch(() => props.retryKey, () => {
      requestedLength.value = undefined;
      requestMoreIfNeeded();
    });
    watch(() => props.continuationKey, () => {
      requestedLength.value = undefined;
      requestMoreAutomatically();
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
    const rememberFocusedItem = () => {
      const element = document.activeElement;
      focusedItemBeforeUpdate = element instanceof HTMLButtonElement
        && element.classList.contains("vh-invocation-list__item")
        && viewport.value?.contains(element)
        && element.dataset.invocationId
        ? { element, id: element.dataset.invocationId, status: element.dataset.status }
        : undefined;
    };
    const restoreMovedItemFocus = async () => {
      const focused = focusedItemBeforeUpdate;
      focusedItemBeforeUpdate = undefined;
      if (!focused || focused.element.isConnected) return;
      await nextTick();
      const element = [...(viewport.value?.querySelectorAll<HTMLButtonElement>("[data-invocation-id]") ?? [])]
        .find(candidate => candidate.dataset.invocationId === focused.id);
      if (!element || element.dataset.status === focused.status) return;
      element.focus();
    };

    return () => h("nav", {
      "aria-label": props.ariaLabel,
      class: "vh-invocation-list",
      onScroll: requestMoreOnScroll,
      onVnodeBeforeUpdate: rememberFocusedItem,
      onVnodeUpdated: restoreMovedItemFocus,
      ref: viewport,
    }, [
      slots.header?.({ items: props.items }),
      props.items.length === 0
        ? slots.empty?.() ?? h("p", { class: "vh-invocation-list__empty" }, "No sessions yet.")
        : null,
      props.items.length
        ? h("ul", { "aria-busy": props.loading ? "true" : undefined, class: "vh-invocation-list__group-items" }, props.items.map(item => renderItem(item, props.selectedId, props.now, select)))
        : null,
      props.loading && props.items.length ? slots.loading?.() ?? h("p", { class: "vh-invocation-list__loading", role: "status" }, "Loading sessions…") : null,
      slots.footer?.({ items: props.items }),
    ]);
  },
});
