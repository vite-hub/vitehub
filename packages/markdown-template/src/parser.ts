import { defineComarkPlugin } from "comark"
import binding from "comark/plugins/binding"
import html from "comark/plugins/html"
import type { ComarkParseTokensState, ComarkPlugin } from "comark"

const openTag = /^(\s*<\s*[A-Za-z][\w:-]*)(\s+[\s\S]*?)?(\s*\/?>\s*)$/
// Same attribute grammar as Comark's HTML attribute reader.
const attribute = /([:\w.-]+)(\s*=\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))?/g

/**
 * Comark 0.8 decodes HTML attribute values with the body decoder, so `&copy=2` becomes `©=2`.
 * Browsers leave that reference alone inside attributes. Escape `&` before Comark decodes,
 * so the template receives the authored value and applies attribute decoding itself.
 */
const rawHtmlAttributes = defineComarkPlugin(() => ({
  name: "vitehub-raw-html-attributes",
  markdownItPost(state: ComarkParseTokensState) {
    const visit = (tokens: ComarkParseTokensState["tokens"]) => {
      for (const token of tokens) {
        if (token.type === "html_inline") token.content = escapeAttributeValues(token.content)
        if (token.children) visit(token.children)
      }
    }
    visit(state.tokens)
  },
}))

function escapeAttributeValues(tag: string): string {
  const match = tag.match(openTag)
  if (!match?.[2]?.includes("&")) return tag
  const attributes = match[2].replace(attribute, (source, name: string, equals?: string, double?: string, single?: string, bare?: string) => {
    if (!equals) return source
    const escape = (value: string) => value.replaceAll("&", "&amp;")
    if (double !== undefined) return `${name}${equals}"${escape(double)}"`
    if (single !== undefined) return `${name}${equals}'${escape(single)}'`
    return bare === undefined ? source : `${name}${equals}${escape(bare)}`
  })
  return `${match[1]}${attributes}${match[3]}`
}

const comarkHtml = html({ markdown: false })

/**
 * Comark 0.8 lifts a paragraph whose only child is an HTML element out to a block element, so
 * `<policy>Use it.</policy>` renders with its body on separate lines. It only lifts paragraphs that
 * start with an HTML token; a leading empty text token keeps authored inline HTML inline. This runs
 * before Comark converts HTML blocks to paragraphs, so those keep their block layout.
 */
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

/** Plugins that keep authored HTML blocks raw and their attributes undecoded, as the template renderer expects. */
export const htmlPlugins: ComarkPlugin[] = [inlineHtml, rawHtmlAttributes()]

export const parserOptions = { autoClose: false, autoUnwrap: false, linkify: false, plugins: [...htmlPlugins, binding()] }
