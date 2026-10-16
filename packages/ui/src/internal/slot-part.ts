import { type Component, defineComponent, h, type PropType } from "vue";

// A styled part has no behavior: it renders one element with its `data-slot` and lets `class` and other attributes fall through.
// `styles.css` styles each part by its `data-slot`, the same attribute that shadcn/ui uses.
export function slotPart(name: string, slot: string, tag: string = "div", attrs: Record<string, string> = {}) {
  return defineComponent({
    name,
    setup(_props, { attrs: fallthroughAttrs, slots }) {
      return () => h(tag, { ...fallthroughAttrs, ...attrs, "data-slot": slot }, slots.default?.());
    },
  });
}

// The Vue form of shadcn/ui's `render` prop: render the part as another element or component, for example a link.
export const asProp = (tag: string) => ({ default: tag, type: [String, Object] as PropType<string | Component> });
