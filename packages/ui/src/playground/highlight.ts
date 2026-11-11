// Colors the editors of PlaygroundRender. PlaygroundRender imports this module only after its first render, so Shiki
// does not delay the page. The JavaScript regex engine keeps WebAssembly out of the page.
import { createHighlighterCore, type LanguageInput } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import dark from "shiki/themes/github-dark-default.mjs";
import light from "shiki/themes/github-light-high-contrast.mjs";

/** Returns a function that colors code as HTML, or gives `undefined` for a language that did not load. */
export async function createHighlight(languages: LanguageInput[]) {
  const highlighter = await createHighlighterCore({
    engine: createJavaScriptRegexEngine({ forgiving: true }),
    langs: languages,
    themes: [light, dark],
  });
  const loaded = new Set(highlighter.getLoadedLanguages());
  return (code: string, language: string) => loaded.has(language)
    ? highlighter.codeToHtml(code, { lang: language, themes: { dark: "github-dark-default", light: "github-light-high-contrast" } })
    : undefined;
}
