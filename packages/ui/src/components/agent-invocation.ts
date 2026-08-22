import { deriveTraceRuns } from "@vite-hub/runtime";
import { defineComponent, h, type PropType, resolveComponent } from "vue";
import type { AgentInvocationView } from "../types.ts";
import { AgentTrace } from "./agent-trace.ts";

export const AgentInvocation = defineComponent({
  name: "AgentInvocation",
  props: {
    invocation: { required: true, type: Object as PropType<AgentInvocationView> },
  },
  setup(props, { slots }) {
    const UBadge = resolveComponent("UBadge");
    return () => {
      const runs = deriveTraceRuns(props.invocation.observations);
      const color =
        props.invocation.status === "failed"
          ? "error"
          : props.invocation.status === "completed"
            ? "success"
            : props.invocation.status === "cancelled"
              ? "neutral"
              : "warning";
      return h(
        "article",
        {
          class: "vh-invocation",
          "data-status": props.invocation.status,
          "data-slot": "invocation",
        },
        [
          h("header", { class: "vh-invocation__header" }, [
            h("div", [
              h(
                "h3",
                { class: "vh-invocation__title" },
                slots.title?.({ invocation: props.invocation }) ??
                  props.invocation.agentName ??
                  "Agent invocation",
              ),
              h("code", { class: "vh-invocation__id" }, props.invocation.id),
            ]),
            h(UBadge, { color, variant: "subtle" }, { default: () => props.invocation.status }),
          ]),
          props.invocation.error
            ? h(
                "div",
                { class: "vh-invocation__error", role: "alert" },
                props.invocation.error.message,
              )
            : null,
          slots.metadata?.({ invocation: props.invocation }),
          runs.map((run) => h(AgentTrace, { key: run.id, run }, slots)),
        ],
      );
    };
  },
});
