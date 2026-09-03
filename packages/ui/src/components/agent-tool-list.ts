import { defineComponent, h, type PropType } from "vue";
import type { AgentToolInspection } from "../types.ts";

function schemaBlock(label: string, schema: AgentToolInspection["inputSchema"]) {
  if (schema === undefined) return null;
  return h("section", { class: "vh-agent-tool-list__schema" }, [
    h("strong", label),
    h("pre", JSON.stringify(schema, null, 2)),
  ]);
}

export const AgentToolList = defineComponent({
  name: "AgentToolList",
  props: {
    callCounts: {
      // SAFETY: Vue validates this optional prop as a Map before exposing it to the component.
      type: Map as PropType<ReadonlyMap<string, number>>,
    },
    tools: {
      required: true,
      // SAFETY: Vue uses Array at runtime while PropType carries the readonly element contract.
      type: Array as PropType<readonly AgentToolInspection[]>,
    },
  },
  setup(props) {
    return () =>
      h(
        "div",
        { class: "vh-agent-tool-list" },
        [...props.tools]
          .sort((left, right) =>
            (props.callCounts?.get(right.name) ?? 0) - (props.callCounts?.get(left.name) ?? 0)
            || left.name.localeCompare(right.name),
          )
          .map((tool) => {
            const count = props.callCounts?.get(tool.name) ?? 0;
            const usage = props.callCounts ? { "data-used": count ? "true" : "false" } : {};
            const hasDetails = Boolean(
              tool.description || tool.inputSchema !== undefined || tool.outputSchema !== undefined,
            );
            if (!hasDetails) {
              return h("div", { ...usage, class: "vh-agent-tool-list__item", key: tool.name }, [
                h("code", tool.name),
                props.callCounts
                  ? h("span", { class: "vh-invocation-tool-list__count" }, count || "—")
                  : null,
              ]);
            }
            return h("details", { ...usage, class: "vh-agent-tool-list__disclosure", key: tool.name }, [
              h("summary", [
                h("code", tool.name),
                h("small", tool.description || "Tool contract"),
                props.callCounts
                  ? h("span", {
                      "aria-label": count ? `${count} call${count === 1 ? "" : "s"}` : "Not used",
                      class: "vh-invocation-tool-list__count",
                    }, count || "—")
                  : null,
                h(
                  "svg",
                  {
                    "aria-hidden": "true",
                    class: "vh-agent-tool-list__chevron",
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
              h("div", { class: "vh-agent-tool-list__body" }, [
                tool.description ? h("p", tool.description) : null,
                schemaBlock("Input schema", tool.inputSchema),
                schemaBlock("Output schema", tool.outputSchema),
              ]),
            ]);
          }),
      );
  },
});
