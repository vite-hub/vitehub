import { defineComponent, h, type PropType } from "vue";
import { asProp, slotPart } from "../internal/slot-part.ts";

export type MarkerVariant = "default" | "border" | "separator";

export const Marker = defineComponent({
  name: "Marker",
  props: {
    as: asProp("div"),
    variant: { default: "default", type: String as PropType<MarkerVariant> },
  },
  setup(props, { attrs, slots }) {
    return () => h(props.as, { ...attrs, "data-slot": "marker", "data-variant": props.variant }, slots.default?.());
  },
});

export const MarkerIcon = slotPart("MarkerIcon", "marker-icon", "span", { "aria-hidden": "true" });
export const MarkerContent = slotPart("MarkerContent", "marker-content", "span");
