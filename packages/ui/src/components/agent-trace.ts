import type { TraceRunView, TraceStepView } from "@vite-hub/runtime";
import { defineComponent, h, type PropType, resolveComponent } from "vue";

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
                          ? "warning"
                          : "success",
                    variant: "subtle",
                  },
                  { default: () => props.run.status },
                ),
                h("span", { class: "vh-trace__duration" }, formatDuration(props.run.durationMs)),
              ]),
            content: () =>
              h(
                "div",
                { class: "vh-trace__steps" },
                props.run.steps.map((step: TraceStepView) =>
                  h(
                    "article",
                    {
                      class: "vh-trace__step",
                      "data-status": step.status,
                      key: step.id,
                    },
                    slots.step?.({ step }) ?? [
                      h("div", { class: "vh-trace__step-heading" }, [
                        h("span", step.name),
                        h("span", formatDuration(step.durationMs)),
                      ]),
                      step.attributes && Object.keys(step.attributes).length > 0
                        ? h(
                            "pre",
                            { class: "vh-trace__attributes" },
                            JSON.stringify(step.attributes, null, 2),
                          )
                        : null,
                    ],
                  ),
                ),
              ),
          },
        ),
      ]);
  },
});
