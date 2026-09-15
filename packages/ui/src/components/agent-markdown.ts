import { Markdown, type MarkdownProps } from "@comark/vue";
import { defineComponent, h, type PropType } from "vue";
import katex from "katex";
import { markdownMath } from "../internal/markdown-math.ts";
import { useViteHubUI } from "../config.ts";
import { ImagePreview } from "../internal/image-preview.ts";

const AgentMath = defineComponent({
  name: "AgentMath",
  props: { content: { default: "", type: String }, class: { default: "", type: String } },
  setup(props) {
    return () => {
      const displayMode = props.class.includes("block");
      try {
        const html = katex.renderToString(props.content, { displayMode, throwOnError: true, trust: false, maxExpand: 1000 });
        return h(displayMode ? "div" : "span", { class: props.class, innerHTML: html });
      } catch {
        return h(displayMode ? "pre" : "code", { class: "vh-math-fallback" }, props.content);
      }
    };
  },
});

export const AgentMarkdown = defineComponent({
  name: "AgentMarkdown",
  inheritAttrs: false,
  props: {
    components: { type: Object as PropType<MarkdownProps["components"]> },
    options: { type: Object as PropType<MarkdownProps["options"]> },
    plugins: { type: Array as PropType<MarkdownProps["plugins"]> },
    streaming: { default: false, type: Boolean },
    value: { default: "", type: String },
  },
  setup(props, { attrs }) {
    const defaults = useViteHubUI();
    return () => {
      return h(Markdown, {
        ...attrs,
        class: [defaults.markdown.class, attrs.class],
        components: { img: ImagePreview, math: AgentMath, ...props.components },
        plugins: [markdownMath, ...(props.plugins ?? [])],
        options: { ...props.options, html: false },
        streaming: props.streaming,
        value: props.value,
      });
    };
  },
});
