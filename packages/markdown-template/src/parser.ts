import { defineComarkPlugin } from "comark"
import binding from "comark/plugins/binding"
import html from "comark/plugins/html"
import type { ComarkParseTokensState, ComarkPlugin, ElementNode } from "comark"

const openTag = /^(\s*<\s*[A-Za-z][\w:-]*)(\s+[\s\S]*?)?(\s*\/?>\s*)$/
const attribute = /([:\w.-]+)(\s*=\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))?/g

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

const literalHtmlTags = new Set(["code", "pre", "script", "style", "textarea", "kbd", "samp", "var"])

/** Whether authored HTML children are reparsed as Markdown by the template renderer. */
export function hasMarkdownHtmlChildren([tag, attrs, ...children]: ElementNode): boolean {
  return attrs.$?.html === 1 && attrs.$?.block === 1 && tag !== "a" && tag !== "img"
    && !literalHtmlTags.has(tag) && children.every(child => typeof child === "string")
}
