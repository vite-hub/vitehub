import type { HighlighterCore, LanguageRegistration } from "shiki/core";
import { h, onServerPrefetch, shallowRef, type ShallowRef, toValue, type MaybeRefOrGetter, type VNode, watch } from "vue";

type LanguageModule = { default: LanguageRegistration[] };

// The languages of shadcn/ui's highlighter. Each one loads the first time it is used. Other languages render as plain text.
const languages: Record<string, () => Promise<LanguageModule>> = {
  bash: () => import("shiki/langs/bash.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

const aliases: Record<string, string> = { js: "javascript", md: "markdown", sh: "bash", shell: "bash", ts: "typescript", yml: "yaml" };

let highlighter: Promise<HighlighterCore> | undefined;

function loadHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-light-default.mjs"),
    import("shiki/themes/github-dark-default.mjs"),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark]) =>
    createHighlighterCore({ engine: createJavaScriptRegexEngine(), langs: [], themes: [light.default, dark.default] }),
  );
  return highlighter;
}

function plainLines(code: string): VNode[] {
  return code.replace(/\n$/, "").split("\n").map((line) => h("span", line));
}

/**
 * Highlights `code` with Shiki and returns one node per line for `CodeBlockLine`.
 * The first render shows plain text; server rendering waits for the highlighted lines.
 * Use `"ansi"` for terminal output with color escape codes.
 */
export function useHighlightedCode(code: MaybeRefOrGetter<string>, language: MaybeRefOrGetter<string>): ShallowRef<VNode[]> {
  const lines = shallowRef(plainLines(toValue(code)));

  let generation = 0;

  async function highlight() {
    const request = ++generation;
    const source = toValue(code);
    const requestedLanguage = toValue(language);
    const requested = requestedLanguage.toLowerCase();
    const lang = aliases[requested] ?? requested;
    if (lang !== "ansi" && !languages[lang]) {
      if (request === generation && source === toValue(code) && requestedLanguage === toValue(language)) lines.value = plainLines(source);
      return;
    }
    const instance = await loadHighlighter();
    if (lang !== "ansi" && !instance.getLoadedLanguages().includes(lang)) await instance.loadLanguage((await languages[lang]!()).default);
    // Every theme color is a CSS variable; styles.css picks the light or dark one.
    const { tokens } = instance.codeToTokens(source.replace(/\n$/, ""), {
      defaultColor: false,
      lang,
      themes: { dark: "github-dark-default", light: "github-light-default" },
    });
    if (request !== generation || source !== toValue(code) || requestedLanguage !== toValue(language)) return;
    lines.value = tokens.map((line) => h("span", line.map((token) => h("span", { style: token.htmlStyle }, token.content))));
  }

  watch([() => toValue(code), () => toValue(language)], () => void highlight().catch(() => {}), { immediate: typeof window !== "undefined" });
  onServerPrefetch(() => highlight().catch(() => {}));
  return lines;
}
