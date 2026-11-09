import { icons, type ViteHubIconName } from "@vite-hub/icons";
import { defineComponent, h, type PropType } from "vue";

/** Name of an icon in the `@vite-hub/icons` set: one for each Server Primitive, Console area, and docs area. */
export type PrimitiveIconName = ViteHubIconName;

export function isPrimitiveIconName(value: unknown): value is PrimitiveIconName {
  return typeof value === "string" && Object.hasOwn(icons.icons, value);
}

export const primitiveIconNames: readonly PrimitiveIconName[] = Object.keys(icons.icons).filter(isPrimitiveIconName);

/** Returns the set icon that an Iconify name such as `i-vitehub-kv` or `vitehub:kv` names, or a bare name such as `kv`. */
export function resolvePrimitiveIconName(icon: string): PrimitiveIconName | undefined {
  const name = icon.replace(/^(?:i-vitehub-|vitehub:)/, "");
  return isPrimitiveIconName(name) ? name : undefined;
}

/**
 * Inline SVG of a `@vite-hub/icons` icon, so the part that each icon marks with `data-motion` can move when its rail item
 * gets a pointer or keyboard focus. `styles.css` sets the motion of each icon. Strokes use currentColor.
 */
export const PrimitiveIcon = defineComponent({
  name: "PrimitiveIcon",
  props: {
    name: {
      required: true,
      // SAFETY: Vue's runtime String constructor is paired with the closed icon name union.
      type: String as PropType<PrimitiveIconName>,
    },
  },
  setup(props) {
    return () => h("svg", {
      "aria-hidden": "true",
      class: "vh-primitive-icon",
      "data-icon": props.name,
      innerHTML: icons.icons[props.name].body,
      viewBox: "0 0 24 24",
      xmlns: "http://www.w3.org/2000/svg",
    });
  },
});
