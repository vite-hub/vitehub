import { defineComponent, h } from "vue"

import { icons } from "virtual:comments-overlay-icons"

const size = { sm: "sm", xs: "xs" } as const

/** The icons of the comment parts, as inline SVG. Nuxt UI's `UIcon` would pull its whole icon runtime into the page. */
export const UIcon = defineComponent({
  name: "UIcon",
  inheritAttrs: false,
  props: { name: { default: "", type: String } },
  setup(props, { attrs }) {
    return () => {
      const body = icons[props.name]
      if (!body) return h("span", { ...attrs, "aria-hidden": "true", "data-slot": "overlay-icon" })
      return h("svg", { ...attrs, "aria-hidden": "true", "data-slot": "overlay-icon", fill: "currentColor", innerHTML: body, viewBox: "0 0 256 256" })
    }
  },
})

/** The small part of Nuxt UI's `UButton` that the comment parts use: a label, an icon, a variant, a size, and a loading state. */
export const UButton = defineComponent({
  name: "UButton",
  inheritAttrs: false,
  props: {
    color: { default: "neutral", type: String },
    disabled: { default: false, type: Boolean },
    icon: { type: String },
    label: { type: String },
    loading: { default: false, type: Boolean },
    size: { default: "sm", type: String },
    square: { default: false, type: Boolean },
    type: { default: "button", type: String },
    variant: { default: "solid", type: String },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        "button",
        {
          ...attrs,
          "aria-busy": props.loading ? "true" : undefined,
          "data-color": props.color,
          "data-size": size[props.size as keyof typeof size] ?? "sm",
          "data-slot": attrs["data-slot"] ?? "overlay-button",
          "data-square": props.square || (!props.label && !slots.default) ? "true" : undefined,
          "data-variant": props.variant,
          disabled: props.disabled || props.loading,
          type: props.type,
        },
        [props.icon ? h(UIcon, { name: props.icon }) : null, props.label ? h("span", props.label) : null, slots.default?.()],
      )
  },
})
