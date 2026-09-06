import { defineComponent, h, type PropType } from "vue";
import { hasRuntimeType } from "../internal/runtime-type.ts";
import type { AgentToolInspection } from "../types.ts";

function schemaBlock(label: string, schema: AgentToolInspection["inputSchema"]) {
  if (schema === undefined) return h("p", { class: "vh-agent-tool-list__unavailable" }, `${label} not recorded.`);
  const object: Record<string, unknown> | undefined = hasRuntimeType(schema, "object") && schema !== null && !Array.isArray(schema) ? Object.fromEntries(Object.entries(schema)) : undefined;
  const properties = object?.properties;
  const fields = hasRuntimeType(properties, "object") && properties !== null && !Array.isArray(properties) ? Object.entries(properties) : [];
  const required = Array.isArray(object?.required) ? object.required : [];
  return h("section", { class: "vh-agent-tool-list__schema" }, [
    h("strong", label),
    fields.length ? h("table", { class: "vh-agent-tool-list__properties" }, [
      h("thead", [h("tr", [h("th", "Field"), h("th", "Type"), h("th", "Description")])]),
      h("tbody", fields.map(([name, value]) => {
        const field: Record<string, unknown> = hasRuntimeType(value, "object") && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
        return h("tr", [
          h("td", [h("code", name), required.includes(name) ? h("small", "Required") : null]),
          h("td", Array.isArray(field.type) ? field.type.join(" | ") : String(field.type || (field.$ref ? "Reference" : "See schema"))),
          h("td", hasRuntimeType(field.description, "string") ? field.description : "—"),
        ]);
      })),
    ]) : null,
    h("details", { open: !fields.length }, [h("summary", "JSON schema"), h("pre", JSON.stringify(schema, null, 2))]),
  ]);
}

export const AgentToolList = defineComponent({
  name: "AgentToolList",
  props: {
    calls: {
      required: false,
      // SAFETY: Vue's runtime Object constructor is paired with the read-only numeric call-count contract.
      type: Object as PropType<Readonly<Record<string, number>>>,
    },
    tools: {
      required: true,
      // SAFETY: Vue's runtime Array constructor is paired with the exported serializable tool-inspection contract.
      type: Array as PropType<readonly AgentToolInspection[]>,
    },
  },
  setup(props) {
    return () =>
      h(
        "div",
        { class: "vh-agent-tool-list" },
        props.tools.map((tool) => {
          const count = props.calls?.[tool.name];
          const usage = props.calls
            ? h("span", {
                "aria-label": count ? `${count} call${count === 1 ? "" : "s"}` : "Not used",
                class: "vh-agent-tool-list__count",
              }, count || "—")
            : null;
          const attributes = {
            "data-used": props.calls ? (count ? "true" : "false") : undefined,
            key: tool.name,
          };
          const hasDetails = Boolean(
            tool.description || tool.inputSchema !== undefined || tool.outputSchema !== undefined,
          );
          if (!hasDetails) {
            return h("div", { ...attributes, class: "vh-agent-tool-list__item" }, [
              h("code", tool.name),
              usage,
            ]);
          }
          return h("details", { ...attributes, class: "vh-agent-tool-list__disclosure" }, [
            h("summary", [
              h("code", tool.name),
              h("small", tool.description || "Tool contract"),
              usage,
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
