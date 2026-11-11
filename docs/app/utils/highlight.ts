import type { HighlighterCore } from "shiki/core";

let highlighter: Promise<HighlighterCore> | undefined;

/**
 * Highlights code with the themes of the docs Markdown (`packages/docs/src/markdown.ts`) and returns the lines inside
 * `<code>`, ready for a `ProsePre` slot. Code highlighted here can replace a Markdown code block without a color change.
 * The JavaScript regex engine needs no WebAssembly, so it runs in the browser and on Workers alike.
 * Lines whose zero-based index is in `marked` get the `is-marked` class.
 */
export async function highlightCodeLines(code: string, lang: "md" | "ts" | "vue", marked?: ReadonlySet<number>): Promise<string> {
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
    createHighlighterCore({
      themes: [import("shiki/themes/github-light-default.mjs"), import("shiki/themes/github-dark-default.mjs")],
      langs: [import("shiki/langs/markdown.mjs"), import("shiki/langs/typescript.mjs"), import("shiki/langs/vue.mjs")],
      engine: createJavaScriptRegexEngine(),
    }));
  const html = (await highlighter).codeToHtml(code, {
    lang,
    themes: { light: "github-light-default", dark: "github-dark-default" },
    defaultColor: "light",
    transformers: marked?.size
      ? [{ line(node, line) {
          if (marked.has(line - 1)) this.addClassToHast(node, "is-marked");
        } }]
      : [],
  });
  // Nuxt UI shows each line as a block. A newline between two blocks would render as an empty line, so each line
  // ends with its own newline instead, which also keeps empty lines one line high.
  return (html.match(/<code>([\s\S]*)<\/code>/)?.[1] ?? "").replaceAll("</span>\n<span class=\"line", "\n</span><span class=\"line");
}

/** Classes of a highlighted `pre`, so the theme applies the dark colors. */
export const highlightedPreClass = "shiki shiki-themes github-light-default github-dark-default";
