import { type Component, defineComponent, type FunctionalComponent, h, type PropType } from "vue";

// A styled part has no behavior: it renders one element with its `data-slot` and lets `class` and other attributes fall through.
// `styles.css` styles each part by its `data-slot`, the same attribute that shadcn/ui uses.
export function slotPart(name: string, slot: string, tag: string = "div", attrs: Record<string, string> = {}) {
  return defineComponent({
    name,
    setup(_props, { attrs: fallthrough, slots }) {
      return () => h(tag, { ...fallthrough, "data-slot": slot, ...attrs }, slots.default?.());
    },
  });
}

// The Vue form of shadcn/ui's `render` prop: render the part as another element or component, for example a link.
export const asProp = (tag: string) => ({ default: tag, type: [String, Object] as PropType<string | Component> });

// A `@vite-hub/kit` part writes its own `data-slot`, such as `collapsible-trigger`. Pass this as the part's `render`
// slot to render it as `tag` with a ViteHub `data-slot` instead, so `styles.css` keeps its selectors.
export function kitSlot(tag: string, slot: string) {
  return (scope: { props: Record<string, unknown>; children: FunctionalComponent }) => [h(tag, { ...scope.props, "data-slot": slot }, h(scope.children))];
}
