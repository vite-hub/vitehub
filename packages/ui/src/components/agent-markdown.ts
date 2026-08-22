import { Markdown, type MarkdownProps } from "@comark/vue";
import { defineComponent, h, type PropType } from "vue";
import { useViteHubUI } from "../config.ts";

export const AgentMarkdown = defineComponent({
  name: "AgentMarkdown",
  inheritAttrs: false,
  props: {
    components: { type: Object as PropType<MarkdownProps["components"]> },
    options: { type: Object as PropType<MarkdownProps["options"]> },
    streaming: { default: false, type: Boolean },
    value: { default: "", type: String },
  },
  setup(props, { attrs }) {
    const defaults = useViteHubUI();
    return () =>
      h(Markdown, {
        ...attrs,
        class: [defaults.markdown.class, attrs.class],
        components: props.components,
        options: { ...props.options, streaming: props.streaming },
        value: props.value,
      });
  },
});
