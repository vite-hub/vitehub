import type { HighlighterCore } from "shiki/core";

let highlighter: Promise<HighlighterCore> | undefined;

/**
 * Highlights code with the docs themes and returns the lines inside `<code>`, ready for a `ProsePre` slot.
 * The JavaScript regex engine needs no WebAssembly, so it runs in the browser and on Workers alike.
 */
export async function highlightCodeLines(code: string, lang: "md" | "ts" | "vue"): Promise<string> {
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
    createHighlighterCore({
      themes: [import("shiki/themes/material-theme-lighter.mjs"), import("shiki/themes/material-theme-palenight.mjs")],
      langs: [import("shiki/langs/markdown.mjs"), import("shiki/langs/typescript.mjs"), import("shiki/langs/vue.mjs")],
      engine: createJavaScriptRegexEngine(),
    }));
  const html = (await highlighter).codeToHtml(code, {
    lang,
    themes: { light: "material-theme-lighter", dark: "material-theme-palenight" },
    defaultColor: "light",
  });
  // Nuxt UI shows each line as a block. A newline between two blocks would render as an empty line, so each line
  // ends with its own newline instead, which also keeps empty lines one line high.
  return (html.match(/<code>([\s\S]*)<\/code>/)?.[1] ?? "").replaceAll("</span>\n<span class=\"line\">", "\n</span><span class=\"line\">");
}

/** Classes of a highlighted `pre`, so the theme applies the dark colors. */
export const highlightedPreClass = "shiki shiki-themes material-theme-lighter material-theme-palenight";
