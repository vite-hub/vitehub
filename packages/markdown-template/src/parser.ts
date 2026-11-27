import alert from "comark/plugins/alert"
import attributes from "comark/plugins/attributes"
import binding from "comark/plugins/binding"
import components from "comark/plugins/components"
import frontmatter from "comark/plugins/frontmatter"
import html from "comark/plugins/html"
import taskList from "comark/plugins/task-list"
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

const defaultPlugins = [frontmatter, alert, taskList, components, attributes]

/**
 * Comark's default plugins without linkify, so plain URLs stay text, then `plugins`.
 * A plugin in `plugins` replaces the default plugin with the same name, as Comark does.
 */
export function templatePlugins(...plugins: ComarkPlugin[]): ComarkPlugin[] {
  const names = new Set(plugins.map(plugin => plugin.name))
  return [...defaultPlugins.map(plugin => plugin()).filter(plugin => !names.has(plugin.name)), ...plugins]
}

const bindingPlugin = binding()

export const parserOptions = { autoClose: false, autoUnwrap: false, registerDefaultPlugins: false, plugins: templatePlugins(...htmlPlugins, bindingPlugin) }

/** Parser options for one render, with the caller's extra plugins. */
export function templateParserOptions(plugins: readonly ComarkPlugin[] = []) {
  return { ...parserOptions, plugins: templatePlugins(...htmlPlugins, bindingPlugin, ...plugins) }
}

/** HTML tags whose text the renderer keeps as written. */
export const literalHtmlTags: ReadonlySet<string> = new Set(["code", "pre", "script", "style", "textarea", "kbd", "samp", "var"])

/** Whether authored HTML children are reparsed as Markdown by the template renderer. */
export function hasMarkdownHtmlChildren([tag, attrs, ...children]: ElementNode): boolean {
  return attrs.$?.html === 1 && attrs.$?.block === 1 && tag !== "a" && tag !== "img"
    && !literalHtmlTags.has(tag) && children.every(child => typeof child === "string")
}
