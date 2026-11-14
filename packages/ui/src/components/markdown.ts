import { defineAsyncComponent, defineComponent, getCurrentInstance, h, Suspense, type PropType } from "vue";
import type { MarkdownDocumentProps, MarkdownProps } from "@comark/vue";
import { useViteHubUI } from "../config.ts";

export type MarkdownValue = string | NonNullable<MarkdownDocumentProps["value"]>;

// The parser, the comark-ui preset, and their plugins are most of the JavaScript of a page with Markdown. They load
// with the first Markdown that renders, so a page that shows none yet, such as an empty chat, does not download them.
const MarkdownRenderer = defineAsyncComponent(() => import("./markdown-renderer.ts").then(module => module.MarkdownRenderer));

export const Markdown = defineComponent({
  name: "Markdown",
  inheritAttrs: false,
  props: {
    components: { type: Object as PropType<MarkdownProps["components"]> },
    options: { type: Object as PropType<MarkdownProps["options"]> },
    plugins: { type: Array as PropType<MarkdownProps["plugins"]> },
    streaming: { default: false, type: Boolean },
    value: { default: "", type: [String, Object] as PropType<MarkdownValue> },
  },
  setup(props, { attrs }) {
    const instance = getCurrentInstance();
    const hasParentSuspense = Boolean(instance && "suspense" in instance && instance.suspense);
    const defaults = useViteHubUI();
    return () => {
      const markdown = () => h(MarkdownRenderer, {
        ...attrs,
        class: [defaults.markdown.class, attrs.class],
        components: props.components,
        options: props.options,
        plugins: props.plugins,
        streaming: props.streaming,
        value: props.value,
      });
      if (hasParentSuspense) return markdown();
      return h(Suspense, null, {
        default: markdown,
        fallback: () => h("div", { ...attrs, class: [defaults.markdown.class, attrs.class] }, typeof props.value === "string" ? props.value : ""),
      });
    };
  },
});
