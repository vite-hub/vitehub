import { Renderer, JSONUIProvider, type ComponentRegistry, type ComponentRenderProps } from "@json-render/vue";
import type { Spec } from "@json-render/core";
import { computed, defineComponent, h, ref, watch, type PropType, type VNodeChild } from "vue";
import { hasRuntimeType } from "../internal/runtime-type.ts";
import { AgentToolList } from "./agent-tool-list.ts";
import type { AgentInvocationView } from "../types.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && hasRuntimeType(value, "object") && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

const catalogProps: Record<string, readonly string[]> = {
  Stack: [],
  Section: ["title"],
  Text: ["text"],
  KeyValue: ["label", "value"],
  Tools: ["names", "mcpServer"],
};

function readOnlyValue(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (value === null || hasRuntimeType(value, "string") || hasRuntimeType(value, "boolean")) return true;
  if (hasRuntimeType(value, "number")) return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => readOnlyValue(item, depth + 1));
  const fields = record(value);
  if (!fields) return false;
  return Object.entries(fields).every(([key, child]) => key.startsWith("$")
    ? (key === "$state" || key === "$item") && hasRuntimeType(child, "string") && (child === "" || child.startsWith("/"))
    : readOnlyValue(child, depth + 1));
}

/** Validate a bounded, read-only subset of JSON Render before passing it to the renderer. */
export function capabilityInspectionSpec(value: unknown): Spec | undefined {
  const view = record(value);
  const elements = record(view?.elements);
  if (!view || !hasRuntimeType(view.root, "string") || !elements || !Object.hasOwn(elements, view.root)) return;
  if (Object.keys(view).some(key => key !== "root" && key !== "elements")) return;
  if (Object.keys(elements).length > 128) return;
  const parsed: Spec["elements"] = {};
  for (const [id, value] of Object.entries(elements)) {
    if (["__proto__", "prototype", "constructor"].includes(id)) return;
    const element = record(value);
    const props = record(element?.props);
    if (!element || !props || !hasRuntimeType(element.type, "string") || !Object.hasOwn(catalogProps, element.type)) return;
    if (Object.keys(element).some(key => !["type", "props", "children", "repeat"].includes(key))) return;
    const allowedProps = catalogProps[element.type]!;
    if (Object.keys(props).some(key => !allowedProps.includes(key)) || !readOnlyValue(props)) return;
    const children = element.children;
    if (children !== undefined && (!Array.isArray(children) || !children.every(child => hasRuntimeType(child, "string") && Object.hasOwn(elements, child)))) return;
    const repeat = record(element.repeat);
    if (element.repeat !== undefined && (!repeat || !hasRuntimeType(repeat.statePath, "string") || !repeat.statePath.startsWith("/") || (repeat.key !== undefined && !hasRuntimeType(repeat.key, "string")) || Object.keys(repeat).some(key => key !== "statePath" && key !== "key"))) return;
    parsed[id] = {
      type: element.type,
      props,
      ...(Array.isArray(children) ? { children: children.filter((child): child is string => hasRuntimeType(child, "string")) } : {}),
      ...(repeat && hasRuntimeType(repeat.statePath, "string") ? { repeat: { statePath: repeat.statePath, ...(hasRuntimeType(repeat.key, "string") ? { key: repeat.key } : {}) } } : {}),
    };
  }
  let remaining = 512;
  const visit = (id: string, ancestors: Set<string>): boolean => {
    if (--remaining < 0 || ancestors.size > 20 || ancestors.has(id)) return false;
    const next = new Set([...ancestors, id]);
    return parsed[id]!.children?.every(child => visit(child, next)) ?? true;
  };
  return visit(view.root, new Set()) ? { root: view.root, elements: parsed } : undefined;
}

function display(value: unknown): string {
  if (value === undefined || value === null) return "Not recorded";
  return hasRuntimeType(value, "string") ? value : JSON.stringify(value, null, 2);
}

function catalogComponent(render: (props: Record<string, unknown>, children: VNodeChild) => VNodeChild) {
  return defineComponent({
    inheritAttrs: false,
    props: {
      // SAFETY: JSON Render supplies the validated element and resolves its read-only bindings.
      element: { type: Object as PropType<ComponentRenderProps["element"]>, required: true },
    },
    setup(props, { slots }) {
      return () => render(props.element.props, slots.default?.());
    },
  });
}

export const AgentCapabilityInspector = defineComponent({
  name: "AgentCapabilityInspector",
  props: {
    // SAFETY: The public Invocation view is the same serialized contract used by AgentInvocationInspector.
    invocation: { type: Object as PropType<AgentInvocationView>, required: true },
  },
  setup(props) {
    const selectedId = ref<string>();
    const capabilities = computed(() => props.invocation.configuration?.capabilities ?? []);
    const selected = computed(() => capabilities.value.find(capability => capability.id === selectedId.value) ?? capabilities.value[0]);
    const tools = computed(() => props.invocation.configuration?.tools?.filter(tool => tool.capabilityId === selected.value?.id) ?? []);
    const spec = computed(() => capabilityInspectionSpec(selected.value?.inspection?.view));
    watch(() => props.invocation.id, () => { selectedId.value = undefined; });
    const registry: ComponentRegistry = {
      Stack: catalogComponent((_props, children) => h("div", { class: "vh-capability-inspector__stack" }, [children])),
      Section: catalogComponent((props, children) => h("section", { class: "vh-capability-inspector__section" }, [h("h3", display(props.title)), children])),
      Text: catalogComponent(props => props.text ? h("p", display(props.text)) : null),
      KeyValue: catalogComponent(props => h("dl", { class: "vh-capability-inspector__value" }, [h("dt", display(props.label)), h("dd", display(props.value))])),
      Tools: catalogComponent(props => {
        const names = Array.isArray(props.names) ? props.names : undefined;
        const selectedTools = tools.value.filter(tool =>
          (!Object.hasOwn(props, "names") || names?.includes(tool.name))
          && (!Object.hasOwn(props, "mcpServer") || hasRuntimeType(props.mcpServer, "string") && tool.mcp?.server === props.mcpServer));
        return selectedTools.length ? h(AgentToolList, { tools: selectedTools }) : h("p", { class: "vh-capability-inspector__empty" }, "No tool contracts recorded.");
      }),
    };
    return () => h("div", { class: "vh-capability-inspector" }, [
      props.invocation.configuration?.truncated ? h("p", { role: "status" }, "Captured configuration was truncated. Some capabilities or contracts may be missing.") : null,
      capabilities.value.length ? h("nav", { class: "vh-capability-inspector__navigation", "aria-label": "Capabilities" }, capabilities.value.map(capability => h("button", {
        type: "button",
        "aria-pressed": selected.value?.id === capability.id,
        onClick: () => { selectedId.value = capability.id; },
      }, capability.inspection?.label ?? capability.id))) : h("p", { class: "vh-capability-inspector__empty" }, "No capabilities recorded for this Invocation."),
      selected.value ? h("div", { class: "vh-capability-inspector__content", key: `${props.invocation.id}:${selected.value.id}` }, [
        h("h2", selected.value.inspection?.label ?? selected.value.id),
        selected.value.inspection?.truncated ? h("p", { role: "status" }, "Capability inspection was truncated. Some recorded data is missing.") : null,
        selected.value.inspection?.label && selected.value.inspection.label !== selected.value.id ? h("code", selected.value.id) : null,
        spec.value && selected.value.inspection?.state
          ? h(JSONUIProvider, { registry, initialState: selected.value.inspection.state }, { default: () => h(Renderer, { spec: spec.value, registry }) })
          : [
              selected.value.inspection && (!selected.value.inspection.state || selected.value.inspection.view) ? h("p", { class: "vh-capability-inspector__empty" }, selected.value.inspection.view && !spec.value
                ? "This view is unavailable. Recorded tools and data are shown below."
                : "Inspection data was not recorded. Configuration capture may be disabled for this run.") : null,
              tools.value.length ? h(AgentToolList, { tools: tools.value }) : null,
              selected.value.inspection?.state ? h("pre", JSON.stringify(selected.value.inspection.state, null, 2)) : null,
              selected.value.metadata ? h("details", [h("summary", "Configuration"), h("pre", JSON.stringify(selected.value.metadata, null, 2))]) : null,
              !tools.value.length && !selected.value.metadata && !selected.value.inspection ? h("p", "No tools or configuration recorded.") : null,
            ],
      ]) : null,
    ]);
  },
});
