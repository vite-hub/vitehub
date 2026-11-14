import type { TraceRunView, TraceStepView } from "@vite-hub/runtime";
import { defineComponent, h, type PropType } from "vue";
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
import { useUIComponent } from "../internal/nuxt-ui.ts";
import { formatDuration } from "../internal/format.ts";
import { payloadText } from "../internal/payload-text.ts";

type Status = TraceRunView["status"] | TraceStepView["status"];

const statusLabels: Record<string, string> = { cancelled: "Cancelled", completed: "Completed", failed: "Failed", running: "Working" };
const statusIcons: Record<string, string> = {
  cancelled: "i-lucide-circle-minus",
  completed: "i-lucide-circle-check",
  failed: "i-lucide-circle-x",
  running: "i-lucide-circle-dashed",
};

function lineStatus(status: Status): TraceLineStatus | undefined {
  if (status === "failed") return "error";
  if (status === "running") return "running";
  return undefined;
}

function description(status: Status, duration: number | undefined): string {
  // An unknown status from a newer runtime shows as its own text.
  return [Object.hasOwn(statusLabels, status) ? statusLabels[status] : String(status), duration === undefined ? undefined : formatDuration(duration)].filter(Boolean).join(" · ");
}

// One runtime trace run from deriveTraceRuns(), as a Trace line that expands into its timed steps.
export const TraceRun = defineComponent({
  name: "TraceRun",
  props: {
    defaultOpen: { default: false, type: Boolean },
    run: { required: true, type: Object as PropType<TraceRunView> },
  },
  setup(props, { slots }) {
    const UIcon = useUIComponent("UIcon");
    const icon = (status: Status) => h(TraceIcon, () => h(UIcon, { name: Object.hasOwn(statusIcons, status) ? statusIcons[status] : "i-lucide-circle" }));

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
        if (candidate && Object.keys(candidate).length > 0) attributes = candidate;
      } catch {
        // Trace attributes come from instrumented code, so they can be cyclic or throw on access. Keep an object that
        // cannot be inspected, so payloadText() shows why it cannot be shown.
        try {
          attributes = value.attributes;
        } catch {
          attributes = undefined;
        }
      }
      if (!attributes) return h("div", { "aria-label": value.name, "data-trace-step": value.status, key: value.id, role: "group" }, line);
      return h(TraceCollapsible, { "aria-label": value.name, "data-trace-step": value.status, key: value.id, role: "group" }, () => [
        h(TraceCollapsibleTrigger, () => line),
        h(TraceCollapsibleContent, () =>
          h(CodeBlock, { size: "sm" }, () => h(CodeBlockContent, { wrap: true }, () => payloadText(attributes))),
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
