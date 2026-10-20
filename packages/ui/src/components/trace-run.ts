import type { TraceRunView, TraceStepView } from "@vite-hub/runtime";
import { defineComponent, h, type PropType, resolveComponent } from "vue";
import { CodeBlock, CodeBlockContent } from "./code-block.ts";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
  type TraceLineStatus,
} from "./trace.ts";

type Status = TraceRunView["status"] | TraceStepView["status"];

const statusLabels: Record<string, string> = { cancelled: "Cancelled", completed: "Completed", failed: "Failed", running: "Working" };
const statusIcons: Record<string, string> = {
  cancelled: "i-ph-minus-circle-light",
  completed: "i-ph-check-circle-light",
  failed: "i-ph-x-circle-light",
  running: "i-ph-circle-dashed-light",
};

function formatDuration(duration: number | undefined): string | undefined {
  if (duration === undefined) return undefined;
  return duration < 1_000
    ? `${duration} ms`
    : `${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)} s`;
}

function lineStatus(status: Status): TraceLineStatus | undefined {
  if (status === "failed") return "error";
  if (status === "running") return "running";
  return undefined;
}

// Trace attributes come from instrumented code, so they can be cyclic or throw on access.
function attributesText(attributes: Record<string, unknown>): string {
  try {
    return JSON.stringify(attributes, null, 2) ?? "";
  } catch {
    return "[Attributes cannot be shown]";
  }
}

function description(status: Status, duration: number | undefined): string {
  // An unknown status from a newer runtime shows as its own text.
  return [statusLabels[status] ?? String(status), formatDuration(duration)].filter(Boolean).join(" · ");
}

// One runtime trace run from deriveTraceRuns(), as a Trace line that expands into its timed steps.
export const TraceRun = defineComponent({
  name: "TraceRun",
  props: {
    defaultOpen: { default: false, type: Boolean },
    run: { required: true, type: Object as PropType<TraceRunView> },
  },
  setup(props, { slots }) {
    const UIcon = resolveComponent("UIcon");
    const icon = (status: Status) => h(TraceIcon, () => h(UIcon, { name: statusIcons[status] ?? "i-ph-circle-light" }));

    const step = (value: TraceStepView) => {
      const custom = slots.step?.({ step: value });
      if (custom) return h("div", { "aria-label": value.name, "data-trace-step": value.status, key: value.id, role: "group" }, custom);
      const line = h(TraceLine, { status: lineStatus(value.status) }, () => [
        icon(value.status),
        h(TraceTitle, () => value.name),
        h(TraceDescription, () => description(value.status, value.durationMs)),
      ]);
      let attributes: Record<string, unknown> | undefined;
      try {
        const candidate = value.attributes;
        if (candidate) {
          attributes = candidate;
          if (Object.keys(candidate).length === 0) attributes = undefined;
        }
      } catch {
        // Keep the candidate so attributesText can render its fallback.
      }
      if (!attributes) return h("div", { "aria-label": value.name, "data-trace-step": value.status, key: value.id, role: "group" }, line);
      return h(TraceCollapsible, { "aria-label": value.name, "data-trace-step": value.status, key: value.id, role: "group" }, () => [
        h(TraceCollapsibleTrigger, () => line),
        h(TraceCollapsibleContent, () =>
          h(CodeBlock, { size: "sm" }, () => h(CodeBlockContent, { wrap: true }, () => attributesText(attributes))),
        ),
      ]);
    };

    return () => {
      const { run } = props;
      return h(Trace, { "data-run-status": run.status }, () =>
        h(TraceCollapsible, { defaultOpen: props.defaultOpen }, () => [
          h(TraceCollapsibleTrigger, () =>
            h(TraceLine, { status: lineStatus(run.status) }, () => [
              icon(run.status),
              h(TraceTitle, () => slots.title?.({ run }) ?? `Trace ${run.id}`),
              h(TraceDescription, () => description(run.status, run.durationMs)),
            ]),
          ),
          h(TraceCollapsibleContent, () =>
            run.steps.length === 0
              ? h(TraceLine, { status: "pending" }, () => h(TraceTitle, () => "No steps recorded."))
              : h(Trace, () => run.steps.map(step)),
          ),
        ]),
      );
    };
  },
});
