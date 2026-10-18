import { defineComponent, h, type PropType } from "vue";
import { asProp, slotPart } from "../internal/slot-part.ts";

export type BubbleVariant = "default" | "secondary" | "muted" | "tinted" | "outline" | "ghost" | "destructive";
export type BubbleAlign = "start" | "end";

export const BubbleGroup = slotPart("BubbleGroup", "bubble-group");

export const Bubble = defineComponent({
  name: "Bubble",
  props: {
    align: { default: "start", type: String as PropType<BubbleAlign> },
    variant: { default: "default", type: String as PropType<BubbleVariant> },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h("div", { ...attrs, "data-align": props.align, "data-slot": "bubble", "data-variant": props.variant }, slots.default?.());
  },
});

export const BubbleContent = defineComponent({
  name: "BubbleContent",
  props: { as: asProp("div") },
  setup(props, { attrs, slots }) {
    return () => h(props.as, { ...attrs, "data-slot": "bubble-content" }, slots.default?.());
  },
});

export const BubbleReactions = defineComponent({
  name: "BubbleReactions",
  props: {
    align: { default: "end", type: String as PropType<BubbleAlign> },
    side: { default: "bottom", type: String as PropType<"top" | "bottom"> },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h("div", { ...attrs, "data-align": props.align, "data-side": props.side, "data-slot": "bubble-reactions" }, slots.default?.());
  },
});
