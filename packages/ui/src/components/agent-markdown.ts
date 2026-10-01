import { Markdown, type MarkdownProps } from "@comark/vue";
import alert from "@comark/vue/plugins/alert";
import attributes from "@comark/vue/plugins/attributes";
import components from "@comark/vue/plugins/components";
import frontmatter from "@comark/vue/plugins/frontmatter";
import taskList from "@comark/vue/plugins/task-list";
import { defineComponent, getCurrentInstance, h, shallowRef, Suspense, type PropType } from "vue";
import { markdownMath } from "../internal/markdown-math.ts";
import { useViteHubUI } from "../config.ts";
import { ImagePreview } from "../internal/image-preview.ts";

type Katex = typeof import("katex").default;

let katexModule: Promise<Katex> | undefined;

// KaTeX is large, so load it with the first formula instead of with every page that renders Markdown.
function loadKatex(): Promise<Katex> {
  katexModule ??= import("katex").then(module => module.default, (error: unknown) => {
    katexModule = undefined;
    throw error;
  });
  return katexModule;
}

function renderMath(katex: Katex, content: string, displayMode: boolean): string | undefined {
  try {
    return katex.renderToString(content, { displayMode, throwOnError: true, trust: false, maxExpand: 1000 });
  } catch {
    return undefined;
  }
}

const AgentMath = defineComponent({
  name: "AgentMath",
  props: { content: { default: "", type: String }, class: { default: "", type: String } },
  setup(props) {
    const katex = shallowRef<Katex>();
    void loadKatex().then(module => {
      katex.value = module;
    }).catch(() => undefined);
    return () => {
      const displayMode = props.class.includes("block");
      const html = katex.value ? renderMath(katex.value, props.content, displayMode) : undefined;
      return html === undefined
        ? h(displayMode ? "pre" : "code", { class: "vh-math-fallback" }, props.content)
        : h(displayMode ? "div" : "span", { class: props.class, innerHTML: html });
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
    const instance = getCurrentInstance();
    const hasParentSuspense = Boolean(instance && "suspense" in instance && instance.suspense);
    const defaults = useViteHubUI();
    return () => {
      const parserOptions = { ...props.options };
      delete parserOptions.html;
      const builtInPlugins = [
        frontmatter(),
        alert(),
        taskList(),
        components(),
        attributes(),
        markdownMath,
      ];
      const plugins = [...builtInPlugins];
      for (const plugin of props.plugins ?? []) {
        const index = plugins.findIndex(existing => existing.name === plugin.name);
        if (index >= 0) plugins[index] = plugin;
        else plugins.push(plugin);
      }
      const safePlugins = plugins.filter(plugin => plugin.name !== "html");
      const markdown = () => h(Markdown, {
        ...attrs,
        class: [defaults.markdown.class, attrs.class],
        components: { img: ImagePreview, math: AgentMath, ...props.components },
        plugins: safePlugins,
        options: { ...parserOptions, registerDefaultPlugins: false },
        streaming: props.streaming,
        value: props.value,
      });
      if (hasParentSuspense) return markdown();
      return h(Suspense, null, {
        default: markdown,
        fallback: () => h("div", { ...attrs, class: [defaults.markdown.class, attrs.class] }, props.value),
      });
    };
  },
});
