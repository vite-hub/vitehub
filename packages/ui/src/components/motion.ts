import { defineComponent, h, nextTick, onMounted, type PropType, ref, watch } from "vue";
import type { Directive } from "vue";
import { swapIcon } from "../motion/helpers/icon.ts";
import type { IconEnter, IconExit } from "../motion/helpers/icon.ts";
import { rollNumber } from "../motion/helpers/number.ts";
import { ring } from "../motion/helpers/ring.ts";
import { morphText } from "../motion/helpers/text.ts";
import { useUIComponent } from "../internal/nuxt-ui.ts";

/**
 * A text that changes letter by letter when `text` changes, with the width following. Use it for a label that changes
 * with state outside a Nuxt UI button, such as "Copy link" to "Copied". The label of a `UButton` already morphs.
 */
export const MorphText = defineComponent({
  name: "MorphText",
  props: {
    text: { required: true, type: String },
    /** The element to render. */
    as: { default: "span", type: String },
  },
  setup(props) {
    const element = ref<HTMLElement>();
    // Vue renders the first text only. Later texts go through the morph, which owns the children of the element.
    const first = props.text;
    watch(() => props.text, (text) => {
      if (element.value) morphText(element.value, text);
    }, { flush: "post" });
    return () => h(props.as, { "ref": element, "data-slot": "morph-text" }, first);
  },
});

/** A number whose changed digits roll when `value` changes: up when it grows, down when it shrinks. */
export const RollNumber = defineComponent({
  name: "RollNumber",
  props: {
    value: { required: true, type: Number },
    /** Turns the number into its text, such as `n => n.toLocaleString()`. */
    // SAFETY: Vue's runtime constructor cannot express the function type.
    format: { default: undefined, type: Function as PropType<(value: number) => string> },
    /** The text of `value` when the app formats it already, such as "$4.20". It wins over `format`. */
    text: { default: undefined, type: String },
    as: { default: "span", type: String },
  },
  setup(props) {
    const element = ref<HTMLElement>();
    const format = (value: number) => props.text ?? (props.format ?? String)(value);
    const first = format(props.value);
    // The first call names the value the element shows, so the next one knows which way to roll.
    onMounted(() => element.value && rollNumber(element.value, props.value, format));
    watch(() => [props.value, props.text, props.format] as const, ([value]) => {
      if (element.value) rollNumber(element.value, value, format);
    }, { flush: "post" });
    return () => h(props.as, { "ref": element, "data-slot": "roll-number", "style": { fontVariantNumeric: "tabular-nums" } }, first);
  },
});

/**
 * An icon that swaps when `name` changes: the old icon blurs out, or leaves the way it points with `exit`, and the new
 * one comes in. A spinner and a check draw their stroke with `enter: "draw"`. Set `exit` and `enter` with the new name.
 * The default slot draws an icon of its own from `{ name }`, such as an inline SVG, in place of `UIcon`.
 */
export const SwapIcon = defineComponent({
  name: "SwapIcon",
  props: {
    name: { required: true, type: String },
    // SAFETY: Vue's runtime constructor cannot express these string literal unions.
    exit: { default: undefined, type: String as PropType<IconExit> },
    enter: { default: undefined, type: String as PropType<IconEnter> },
    /** The icon turns, as a spinner does. */
    spin: { default: false, type: Boolean },
  },
  setup(props, { attrs, slots }) {
    const UIcon = useUIComponent("UIcon");
    const container = ref<HTMLElement>();
    let next = 0;
    const icons = ref([{ key: next++, name: props.name, spin: props.spin }]);
    watch(() => [props.name, props.spin] as const, async ([name, spin]) => {
      const key = next++;
      icons.value = [...icons.value, { key, name, spin }];
      await nextTick();
      const element = container.value?.querySelector(`[data-icon-key="${key}"]`);
      if (!container.value || !element) return;
      swapIcon(container.value, element, {
        exit: props.exit,
        enter: props.enter,
        onRemove: (old) => {
          const gone = Number(old.getAttribute("data-icon-key"));
          icons.value = icons.value.filter(icon => icon.key !== gone);
        },
      });
    });
    // Each icon has its own wrapper, so the swap moves the wrapper and a class on the icon, such as a size, stays. The
    // class goes to each icon, and the other attributes to the container.
    return () => {
      const { class: iconClass, ...rest } = attrs;
      return h("span", { "data-slot": "swap-icon", ...rest, "ref": container, "aria-hidden": "true", "style": { display: "inline-flex", flexShrink: 0 } },
        icons.value.map(icon => h("span", { "key": icon.key, "data-icon-key": icon.key, "style": { display: "inline-flex" } }, [
          slots.default?.({ name: icon.name }) ?? h(UIcon, { name: icon.name, class: [iconClass, icon.spin && "animate-spin"] }),
        ])));
    };
  },
  inheritAttrs: false,
});

/**
 * `v-ring="done"` rings the element once each time `done` becomes true, for a finished action such as saved or copied.
 * `createViteHubUI()` registers it as `v-ring`.
 */
export const vRing: Directive<HTMLElement, unknown> = {
  updated(element, binding) {
    if (binding.value && !binding.oldValue) ring(element);
  },
};
