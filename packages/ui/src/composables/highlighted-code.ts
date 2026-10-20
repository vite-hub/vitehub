import type { HighlighterCore, LanguageRegistration } from "shiki/core";
import { h, onMounted, shallowRef, type ShallowRef, toValue, type MaybeRefOrGetter, type VNode, watch } from "vue";

type LanguageModule = { default: LanguageRegistration[] };

const ansiLanguage = { name: "ansi", scopeName: "source.ansi", patterns: [] } as unknown as LanguageRegistration;

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

// Strip CSI and OSC terminal control sequences from the plain fallback.
// eslint-disable-next-line no-control-regex
const ansiEscapes = /(?:\u001B\]|\u009D)(?:[^\u0007\u001B\u009C]|\u001B(?!\\))*?(?:\u0007|\u001B\\|\u009C)|(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|\u0090[^\u009C\u001B]*(?:\u001B\\|\u009C)/g;

function stripAnsi(code: string): string {
  return code.replace(ansiEscapes, "");
}

function plainLines(code: string, language: string): VNode[] {
  const text = language.toLowerCase() === "ansi" ? stripAnsi(code) : code;
  return text.replace(/\n$/, "").split("\n").map((line) => h("span", line));
}

/**
 * Highlights `code` with Shiki and returns one node per line for `CodeBlockLine`.
 * The server and first browser render show plain text; colors follow after mount.
 * Use `"ansi"` for terminal output with color escape codes.
 */
export function useHighlightedCode(code: MaybeRefOrGetter<string>, language: MaybeRefOrGetter<string>): ShallowRef<VNode[]> {
  const lines = shallowRef(plainLines(toValue(code), toValue(language)));
  let requestId = 0;

  async function highlight() {
    const currentRequest = ++requestId;
    const source = toValue(code);
    const requested = toValue(language).toLowerCase();
    const lang = aliases[requested] ?? requested;
    if (lang !== "ansi" && !languages[lang]) {
      lines.value = plainLines(source, lang);
      return;
    }
    const instance = await loadHighlighter();
    if (!instance.getLoadedLanguages().includes(lang)) await instance.loadLanguage(lang === "ansi" ? [ansiLanguage] : (await languages[lang]!()).default);
    // Every theme color is a CSS variable; styles.css picks the light or dark one.
    const highlightSource = lang === "ansi" ? stripAnsi(source) : source;
    const { tokens } = instance.codeToTokens(highlightSource.replace(/\n$/, ""), {
      defaultColor: false,
      lang,
      themes: { dark: "github-dark-default", light: "github-light-default" },
    });
    if (currentRequest !== requestId || source !== toValue(code) || requested !== toValue(language).toLowerCase()) return;
    lines.value = tokens.map((line) => h("span", line.map((token) => h("span", { style: token.htmlStyle }, token.content))));
  }

  onMounted(() => {
    watch([() => toValue(code), () => toValue(language)], () => void highlight().catch(() => {}), { immediate: true });
  });
  return lines;
}
