import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import postcss from "postcss"

// Inline the design system's relative imports before scoping, including its shared focus rules. Source paths must
// keep pointing at the design system when the resulting stylesheet lives in the app's .nuxt directory.
function readTheme(file: string): postcss.Root {
  const css = postcss.parse(readFileSync(file, "utf8"), { from: file })
  css.walkAtRules("import", (rule) => {
    const path = rule.params.match(/^["'](\.[^"']+)["']$/)?.[1]
    if (path) rule.replaceWith(readTheme(resolve(dirname(file), path)).nodes)
  })
  css.walkAtRules("source", (rule) => {
    const path = rule.params.match(/^["'](\.[^"']+)["']$/)?.[1]
    if (path) rule.params = JSON.stringify(resolve(dirname(file), path))
  })
  return css
}

// The shadcn/ui names that theme.css sets and its Nuxt UI and ViteHub tokens read.
const shadcnTokens = new Set(["--background", "--foreground", "--muted", "--muted-foreground", "--border", "--primary", "--popover", "--ring", "--radius"])

/** The shared design system on docs pages inside an app, without changing the app's Tailwind font theme or primary. */
export function docsThemeCss(file: string): string {
  const css = readTheme(file)
  // The app keeps its own shadcn/ui tokens on docs pages, so each token of the theme takes the theme's value directly.
  css.walkRules((rule) => {
    const values = new Map<string, string>()
    rule.each((node) => {
      if (node.type === "decl" && shadcnTokens.has(node.prop)) {
        values.set(node.prop, node.value)
        node.remove()
      }
    })
    rule.each((node) => {
      if (node.type === "decl") node.value = node.value.replace(/var\((--[\w-]+)\)/g, (match, name: string) => values.get(name) ?? match)
    })
  })
  // @theme would put the font variables on every page. The app already has Tailwind's font utilities, which read
  // these variables; only their values on docs pages need to change.
  css.walkAtRules("theme", (rule) => {
    rule.replaceWith(postcss.rule({ selector: ":root", nodes: rule.nodes }))
  })
  css.walkRules((rule) => {
    rule.selectors = rule.selectors.map(selector => /^(?:html|:root)\b/.test(selector)
      ? selector.replace(/^(html|:root)/, "$1:where(.vh-docs)")
      : `:where(.vh-docs) ${selector}`)
  })
  // Unlike a docs-only site, an existing app keeps its Nuxt UI color aliases on docs pages too.
  css.walkDecls("--ui-primary", (declaration) => { declaration.remove() })
  return css.toString()
}
