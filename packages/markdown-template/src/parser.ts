import binding from "comark/plugins/binding"
import html from "comark/plugins/html"
import type { ComarkPlugin, ElementNode } from "comark"

const comarkHtml = html({ markdown: false })

const inlineHtml: ComarkPlugin = {
  ...comarkHtml,
  markdownItPost(state) {
    for (const [index, token] of state.tokens.entries()) {
      const first = token.children?.[0]
      if (token.type !== "inline" || state.tokens[index - 1]?.type !== "paragraph_open" || first?.type !== "html_inline") continue
      token.children!.unshift(Object.assign(Object.create(Object.getPrototypeOf(first)), first, { type: "text", content: "" }))
    }
    comarkHtml.markdownItPost?.(state)
  },
}

/** Plugins that keep authored HTML blocks raw, as the template renderer expects. */
export const htmlPlugins: ComarkPlugin[] = [inlineHtml]

export const parserOptions = { autoClose: false, autoUnwrap: false, linkify: false, plugins: [...htmlPlugins, binding()] }

/** HTML tags whose text the renderer keeps as written. */
export const literalHtmlTags: ReadonlySet<string> = new Set(["code", "pre", "script", "style", "textarea", "kbd", "samp", "var"])

/** Whether authored HTML children are reparsed as Markdown by the template renderer. */
export function hasMarkdownHtmlChildren([tag, attrs, ...children]: ElementNode): boolean {
  return attrs.$?.html === 1 && attrs.$?.block === 1 && tag !== "a" && tag !== "img"
    && !literalHtmlTags.has(tag) && children.every(child => typeof child === "string")
}
