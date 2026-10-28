import { Markdown as ComarkMarkdown, MarkdownDocument as ComarkDocument, type MarkdownProps, type MarkdownDocumentProps } from "@comark/vue";
import comarkUi from "comark-ui/vue";
import { criticCss, typesetCss } from "comark-ui";
import { pascalCase } from "comark/utils";
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

export type MarkdownValue = string | NonNullable<MarkdownDocumentProps["value"]>;

const preset = comarkUi({ chips: { download: false }, badge: { download: false }, icon: { fetch: false }, diagrams: { draw: false }, github: { html: false } });
const DocumentStyles = defineComponent({
  setup: () => () => h("style", { "data-comark-typeset": "", innerHTML: typesetCss + criticCss }),
});

let katexModule: Promise<Katex> | undefined;
let katexStyles: Promise<void> | undefined;

function loadKatexStyles(): Promise<void> {
  katexStyles ??= import("katex/dist/katex.min.css").then(() => undefined, (error: unknown) => {
    katexStyles = undefined;
    throw error;
  });
  return katexStyles;
}

// KaTeX is large, so load it with the first formula instead of with every page that renders Markdown.
function loadKatex(): Promise<Katex> {
  katexModule ??= Promise.all([import("katex"), loadKatexStyles()]).then(([module]) => module.default, (error: unknown) => {
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
      const parserOptions = { ...props.options };
      delete parserOptions.html;
      const builtInPlugins = [
        frontmatter(),
        alert(),
        taskList(),
        components(),
        attributes(),
        ...preset.plugins.filter(plugin => plugin.name !== "math"),
        markdownMath,
      ];
      const plugins = [...new Map(builtInPlugins.map(plugin => [plugin.name, plugin])).values()];
      for (const plugin of props.plugins ?? []) {
        const index = plugins.findIndex(existing => existing.name === plugin.name);
        if (index >= 0) plugins[index] = plugin;
        else plugins.push(plugin);
      }
      const safePlugins = plugins.filter(plugin => plugin.name !== "html");
      const resolvedComponents: NonNullable<MarkdownProps["components"]> = { ...preset.components, "typeset-styles": DocumentStyles, img: ImagePreview, ...(typeof props.value === "string" ? { math: AgentMath } : {}), ...props.components };
      for (const [name, component] of Object.entries(props.components ?? {})) {
        const tag = pascalCase(name);
        delete resolvedComponents[`Prose${tag}`];
        resolvedComponents[tag] = component;
      }
      const shared = {
        ...attrs,
        class: [defaults.markdown.class, attrs.class],
        components: resolvedComponents,
        streaming: props.streaming,
      };
      const markdown = () => typeof props.value === "string"
        ? h(ComarkMarkdown, { ...shared, plugins: safePlugins, options: { ...parserOptions, registerDefaultPlugins: false }, value: props.value })
        : h(ComarkDocument, { ...shared, value: props.value });
      if (hasParentSuspense) return markdown();
      return h(Suspense, null, {
        default: markdown,
        fallback: () => h("div", { ...attrs, class: [defaults.markdown.class, attrs.class] }, typeof props.value === "string" ? props.value : ""),
      });
    };
  },
});
