import { computed, defineComponent, h, type PropType } from "vue";
import type { AgentInvocationView } from "../types.ts";
import {
  invocationActivities,
  invocationActivityDetail,
  invocationActivityTitle,
  type InvocationActivity,
} from "../internal/invocation-activity.ts";

export type AgentInvocationTimelineOwner = "agent" | "vitehub";

export interface AgentInvocationTimelineItem {
  activity: InvocationActivity;
  detail?: string;
  /** Milliseconds the step took, when the trace recorded an end. */
  durationMs: number;
  id: string;
  /** Milliseconds after the Invocation started. */
  offsetMs: number;
  owner: AgentInvocationTimelineOwner;
  /** `+1m 5s · 500ms`, or `start` for the first millisecond. */
  timing: string;
  title: string;
}

export function formatTimelineDuration(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0) return;
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) {
    return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value / 1_000)}s`;
  }
  const seconds = Math.round(value / 1_000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** ViteHub owns preparation, delivery, and its own tools; the Agent owns the rest. */
export function timelineOwner(activity: InvocationActivity): AgentInvocationTimelineOwner {
  const tool = String(activity.attributes["tool.name"] ?? "").toLocaleLowerCase();
  if (
    activity.kind === "preparation"
    || activity.kind === "action"
    || activity.kind === "system"
    || activity.kind === "delivery"
    || activity.name.startsWith("vitehub.")
    || tool === "materialize_sources"
    || tool.startsWith("vitehub_")
  ) return "vitehub";
  return "agent";
}

/** The timed, non-message activities of an Invocation in start order, with their offset from the start. */
export function invocationTimeline(invocation: AgentInvocationView, activities = invocationActivities(invocation)): AgentInvocationTimelineItem[] {
  const items = activities
    .filter(activity => activity.kind !== "message" && Number.isFinite(Date.parse(activity.startedAt ?? "")))
    .sort((a, b) => Date.parse(a.startedAt ?? "") - Date.parse(b.startedAt ?? "") || a.sequence - b.sequence);
  if (!items.length) return [];
  const invocationStart = Date.parse(invocation.startedAt ?? invocation.createdAt ?? "");
  const observedStarts = items.map(activity => Date.parse(activity.startedAt ?? "")).filter(Number.isFinite);
  const zero = Number.isFinite(invocationStart) ? invocationStart : Math.min(...observedStarts);
  return items.map((activity) => {
    const started = Date.parse(activity.startedAt ?? "");
    const durationMs = Number.isFinite(activity.durationMs) ? (activity.durationMs ?? 0) : 0;
    const offsetMs = Number.isFinite(started) ? Math.max(0, started - zero) : 0;
    const timing = [
      offsetMs ? `+${formatTimelineDuration(offsetMs)}` : "start",
      durationMs ? formatTimelineDuration(durationMs) : undefined,
    ].filter(Boolean).join(" · ");
    const item: AgentInvocationTimelineItem = {
      activity,
      durationMs,
      id: activity.id,
      offsetMs,
      owner: timelineOwner(activity),
      timing,
      title: invocationActivityTitle(activity),
    };
    const detail = invocationActivityDetail(activity);
    if (detail) item.detail = detail;
    return item;
  });
}

/** One row for each timed step of an Invocation: who ran it, what it did, and when. */
export const AgentInvocationTimeline = defineComponent({
  name: "AgentInvocationTimeline",
  emits: {
    selectActivity: (id: string) => Boolean(id),
  },
  props: {
    // SAFETY: The cast only names the serialized Invocation record for Vue's runtime Object prop; the caller passes an authorized view.
    invocation: { required: true, type: Object as PropType<AgentInvocationView> },
  },
  setup(props, { emit, slots }) {
    const items = computed(() => invocationTimeline(props.invocation));
    return () => h("div", { class: "vh-invocation-timeline", "data-slot": "invocation-timeline" }, [
      items.value.length
        ? h("ol", { class: "vh-invocation-timeline__rows" }, items.value.map(item => h("li", { key: `timeline:${item.id}` }, [
            h("button", {
              class: "vh-invocation-timeline__row",
              "data-activity-id": item.id,
              "data-owner": item.owner,
              "data-status": item.activity.status,
              onClick: () => emit("selectActivity", item.id),
              title: item.detail ? `${item.title} — ${item.detail}` : item.title,
              type: "button",
            }, [
              h("span", { "aria-hidden": "true", class: "vh-invocation-timeline__dot" }),
              // Screen readers hear the owner and the outcome; sighted readers get the dot shape, the ring, and the cross.
              h("span", { class: "vh-visually-hidden" }, `${item.owner === "vitehub" ? "ViteHub" : "Agent"}${item.activity.status === "failed" ? ", failed" : ""}: `),
              h("span", { class: "vh-invocation-timeline__heading" }, [
                h("strong", item.title),
                item.detail ? h("code", { class: "vh-invocation-timeline__detail" }, item.detail) : null,
              ]),
              h("time", { class: "vh-invocation-timeline__time" }, item.timing),
            ]),
          ])))
        : slots.empty?.() ?? h("p", { class: "vh-invocation-timeline__empty" }, "No timed steps recorded."),
    ]);
  },
});
