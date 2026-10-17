import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger, injectCollapsibleRootContext } from "reka-ui";
import { defineComponent, h, useId, type PropType } from "vue";
import { slotPart } from "../internal/slot-part.ts";

export type TraceLineStatus = "running" | "error" | "pending";

export const Trace = slotPart("Trace", "trace");

export const TraceLine = defineComponent({
  name: "TraceLine",
  props: {
    status: { type: String as PropType<TraceLineStatus> },
  },
  setup(props, { attrs, slots }) {
    return () => h("span", { ...attrs, "data-slot": "trace-line", "data-status": props.status }, slots.default?.());
  },
});

export const TraceIcon = slotPart("TraceIcon", "trace-icon", "span", { "aria-hidden": "true" });
export const TraceTitle = slotPart("TraceTitle", "trace-title", "span");
export const TraceDescription = slotPart("TraceDescription", "trace-description", "span");

export const TraceCollapsible = defineComponent({
  name: "TraceCollapsible",
  props: {
    defaultOpen: { default: false, type: Boolean },
    // `undefined` keeps the disclosure uncontrolled; pass `v-model:open` to control it.
    open: { default: undefined, type: Boolean },
  },
  emits: { "update:open": (_open: boolean) => true },
  setup(props, { attrs, emit, slots }) {
    return () =>
      h(
        CollapsibleRoot,
        {
          ...attrs,
          "data-slot": "trace-collapsible",
          defaultOpen: props.defaultOpen,
          open: props.open,
          "onUpdate:open": (open: boolean) => emit("update:open", open),
        },
        { default: () => slots.default?.() },
      );
  },
});

const chevron = () =>
  h("span", { "aria-hidden": "true", "data-slot": "trace-icon", "data-trace-chevron": "" }, [
    h("svg", { fill: "none", viewBox: "0 0 24 24" }, [
      h("path", { d: "m9 18 6-6-6-6", "stroke-linecap": "round", "stroke-linejoin": "round" }),
    ]),
  ]);

export const TraceCollapsibleTrigger = defineComponent({
  name: "TraceCollapsibleTrigger",
  setup(_props, { attrs, slots }) {
    const rootContext = injectCollapsibleRootContext();
    rootContext.contentId ||= useId();
    return () =>
      h(CollapsibleTrigger, { ...attrs, "data-slot": "trace-collapsible-trigger" }, {
        default: () => [slots.default?.(), chevron()],
      });
  },
});

export const TraceCollapsibleContent = defineComponent({
  name: "TraceCollapsibleContent",
  // Classes go to the inner element, as in shadcn/ui, so padding and borders do not break the height animation.
  inheritAttrs: false,
  setup(_props, { attrs, slots }) {
    return () =>
      h(CollapsibleContent, { "data-slot": "trace-collapsible-content" }, {
        default: () => h("div", { ...attrs, "data-slot": "trace-collapsible-content-inner" }, slots.default?.()),
      });
  },
});
