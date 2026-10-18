import type { HighlighterCore, LanguageRegistration } from "shiki/core";
import { h, onServerPrefetch, shallowRef, type ShallowRef, toValue, type MaybeRefOrGetter, type VNode, watch } from "vue";

type LanguageModule = { default: LanguageRegistration[] };

// The languages of shadcn/ui's highlighter. Each one loads the first time it is used. Other languages render as plain text.
const languages: Record<string, () => Promise<LanguageModule>> = {
  bash: () => import("@shikijs/langs/bash"),
  css: () => import("@shikijs/langs/css"),
  diff: () => import("@shikijs/langs/diff"),
  html: () => import("@shikijs/langs/html"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsx: () => import("@shikijs/langs/jsx"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  sql: () => import("@shikijs/langs/sql"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  vue: () => import("@shikijs/langs/vue"),
  yaml: () => import("@shikijs/langs/yaml"),
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

  async function highlight() {
    const source = toValue(code);
    const requested = toValue(language).toLowerCase();
    const lang = aliases[requested] ?? requested;
    if (lang !== "ansi" && !languages[lang]) {
      lines.value = plainLines(source);
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
    const latestRequested = toValue(language).toLowerCase();
    const latestLang = aliases[latestRequested] ?? latestRequested;
    if (source !== toValue(code) || latestLang !== lang) return;
    lines.value = tokens.map((line) => h("span", line.map((token) => h("span", { style: token.htmlStyle }, token.content))));
  }

  watch([() => toValue(code), () => toValue(language)], () => void highlight().catch(() => {}), { immediate: typeof window !== "undefined" });
  onServerPrefetch(() => highlight().catch(() => {}));
  return lines;
}
