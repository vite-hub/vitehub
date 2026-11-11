import { defineComponent, h, type PropType } from "vue";

export type StatusTone = "neutral" | "success" | "warning" | "error" | "info";
export type StatusSize = "sm" | "md";

/**
 * A status as a 6px dot and a label, as Geist's Status Dot. The dot takes the tone's color. The label keeps the color
 * of the text around it, unless `colored` says that the label is the status itself, such as "Failed".
 */
export const Status = defineComponent({
  name: "Status",
  props: {
    // SAFETY: Vue's runtime constructor cannot express these string literal unions.
    tone: { default: "neutral", type: String as PropType<StatusTone> },
    label: { default: undefined, type: String },
    colored: { default: false, type: Boolean },
    pulse: { default: false, type: Boolean },
    size: { default: "sm", type: String as PropType<StatusSize> },
  },
  setup(props, { slots }) {
    return () => {
      const label = slots.default?.() ?? props.label;
      return h("span", {
        "data-colored": props.colored ? "" : undefined,
        "data-size": props.size,
        "data-slot": "status",
        "data-tone": props.tone,
      }, [
        h("span", { "aria-hidden": "true", "data-pulse": props.pulse ? "" : undefined, "data-slot": "status-indicator" }),
        label === undefined || label === "" ? null : h("span", { "data-slot": "status-label" }, label),
      ]);
    };
  },
});
