import type { TraceRunView, TraceStepView } from "@vite-hub/runtime";
import { defineComponent, h, type PropType, resolveComponent } from "vue";

function traceAttributesText(value: unknown): string | undefined {
  try {
    if (!value || Object.keys(value).length === 0) return undefined;
    const ancestors: object[] = [];
    return JSON.stringify(value, function (this: unknown, _key, item: unknown) {
      if (typeof item === "bigint") return `${item}n`;
      if (item === null || typeof item !== "object") return item;
      while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
      if (ancestors.includes(item)) return "[Circular]";
      ancestors.push(item);
      return item;
    }, 2) ?? String(value);
  } catch (error) {
    return error instanceof Error ? `[Unable to display payload: ${error.message}]` : "[Unable to display payload]";
  }
}

function formatDuration(duration: number | undefined): string | undefined {
  if (duration === undefined) return undefined;
  return duration < 1_000
    ? `${duration} ms`
    : `${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)} s`;
}

export const AgentTrace = defineComponent({
  name: "AgentTrace",
  props: {
    defaultOpen: { default: false, type: Boolean },
    run: { required: true, type: Object as PropType<TraceRunView> },
  },
  setup(props, { slots }) {
    const UBadge = resolveComponent("UBadge");
    const UCollapsible = resolveComponent("UCollapsible");
    return () =>
      h("section", { class: "vh-trace", "data-status": props.run.status, "data-slot": "trace" }, [
        h(
          UCollapsible,
          { defaultOpen: props.defaultOpen },
          {
            default: () =>
              h("button", { class: "vh-trace__trigger", type: "button" }, [
                h(
                  "span",
                  { class: "vh-trace__title" },
                  slots.title?.({ run: props.run }) ?? `Trace ${props.run.id}`,
                ),
                h(
                  UBadge,
                  {
                    color:
                      props.run.status === "failed"
                        ? "error"
                        : props.run.status === "running"
                          ? "info"
                          : props.run.status === "completed"
                            ? "success"
                            : "neutral",
                    size: "xs",
                    variant: "outline",
                  },
                  {
                    default: () => {
                      const labels = {
                        cancelled: "Cancelled",
                        completed: "Completed",
                        failed: "Failed",
                        running: "Working",
                      };
                      return Object.hasOwn(labels, props.run.status) ? labels[props.run.status] : "Unknown";
                    },
                  },
                ),
                h("span", { class: "vh-trace__duration" }, formatDuration(props.run.durationMs)),
                h(
                  "svg",
                  {
                    "aria-hidden": "true",
                    class: "vh-trace__chevron",
                    fill: "none",
                    viewBox: "0 0 24 24",
                  },
                  [
                    h("path", {
                      d: "m7 10 5 5 5-5",
                      "stroke-linecap": "round",
                      "stroke-linejoin": "round",
                    }),
                  ],
                ),
              ]),
            content: () =>
              h(
                "div",
                { class: "vh-trace__steps" },
                props.run.steps.length === 0
                  ? h("p", { class: "vh-trace__empty" }, "No steps recorded.")
                  : props.run.steps.map((step: TraceStepView) =>
                      h(
                        "article",
                        {
                          "aria-label": step.name,
                          class: "vh-trace__step",
                          "data-status": step.status,
                          key: step.id,
                        },
                        slots.step?.({ step }) ?? [
                          h("div", { class: "vh-trace__step-heading" }, [
                            h("span", step.name),
                            step.status === "completed"
                              ? null
                              : h(
                                  "span",
                                  { class: "vh-trace__step-status" },
                                  step.status === "failed" ? "Failed" : "Working",
                                ),
                            h(
                              "span",
                              { class: "vh-trace__duration" },
                              formatDuration(step.durationMs),
                            ),
                          ]),
                          (() => {
                            const text = traceAttributesText(step.attributes);
                            return text === undefined
                              ? null
                              : h("pre", { class: "vh-trace__attributes" }, text);
                          })(),
                        ],
                      ),
                    ),
              ),
          },
        ),
      ]);
  },
});
