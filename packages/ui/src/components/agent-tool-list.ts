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
        props.tools.map((tool) => {
          const hasDetails = Boolean(
            tool.description || tool.inputSchema !== undefined || tool.outputSchema !== undefined,
          );
          if (!hasDetails) {
            return h("div", { class: "vh-agent-tool-list__item", key: tool.name }, [
              h("code", tool.name),
            ]);
          }
          return h("details", { class: "vh-agent-tool-list__disclosure", key: tool.name }, [
            h("summary", [
              h("code", tool.name),
              h("small", tool.description || "Tool contract"),
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
