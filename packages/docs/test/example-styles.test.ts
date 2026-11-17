import { readFileSync } from "node:fs"

import { parseHTML } from "linkedom"
import postcss from "postcss"
import { describe, expect, it } from "vitest"
import { compileStyle, parse } from "vue/compiler-sfc"

const source = readFileSync(new URL("../runtime/app/components/content/Example.vue", import.meta.url), "utf8")
const [style] = parse(source).descriptor.styles
const css = compileStyle({ source: style!.content, id: "data-v-example", scoped: style!.scoped, filename: "Example.vue" }).code
const rules: postcss.Rule[] = []
postcss.parse(css).walkRules(rule => void rules.push(rule))

function subject(selector: string): string {
  let flat = selector
  while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, "")
  return flat.trim().split(/\s*[>+~]\s*|\s+/).at(-1)!
}

function previewDisplays(): { selector: string, display: string }[] {
  const found: { selector: string, display: string }[] = []
  postcss.parse(css).walkDecls("display", (declaration) => {
    const rule = declaration.parent
    if (rule?.type !== "rule") return
    for (const selector of (rule as postcss.Rule).selectors) {
      if (subject(selector).startsWith(".docs-example-preview")) found.push({ selector, display: declaration.value })
    }
  })
  return found
}

function selectorsSetting(property: string, value: string): string[] {
  return rules.filter(rule => rule.nodes.some(node => node.type === "decl" && node.prop === property && node.value === value)).flatMap(rule => rule.selectors)
}

// happy-dom drops everything after the first combinator inside `:has()`, so these selectors need linkedom.
function preview(html: string, view = "preview") {
  const { document } = parseHTML(`<!doctype html><html><body><div class="vh-example" data-view="${view}"><div class="vh-example-body" data-v-example><div class="docs-example-preview">${html}</div><div class="code"></div></div></div></body></html>`)
  return document.querySelector(".docs-example-preview")!
}

function matchesAny(element: Element, property: string, value: string): boolean {
  return selectorsSetting(property, value).some(selector => element.matches(selector))
}

function isFlush(html: string, view = "preview"): boolean {
  return matchesAny(preview(html, view), "display", "flex")
}

function blocksWithoutMargin(html: string): string[] {
  const selectors = selectorsSetting("margin-block", "0")
  return [...preview(html).querySelectorAll("*")].filter(element => selectors.some(selector => element.matches(selector))).map(element => element.className)
}

const gitGraph = "<figure class=\"cgg\" data-comark-frame><svg></svg></figure>"
const bundle = "<figure class=\"cbr\" data-comark-frame><table></table></figure>"
const issues = "<style data-comark-issues></style><details class=\"cis\" data-comark-frame open><summary>1 issue</summary></details>"
const serverDiff = "<div class=\"comark-html\" data-block=\"diff\"><style></style><div class=\"cd\" data-comark-frame></div></div>"

describe("Example.vue styles", () => {
  it("shows the preview only in the Preview view", () => {
    const displays = previewDisplays()
    expect(displays).toContainEqual({ selector: expect.stringContaining(".vh-example[data-view=\"code\"]"), display: "none" })
    const shown = displays.filter(rule => rule.display !== "none")
    expect(shown.length).toBeGreaterThan(0)
    for (const rule of shown) expect(rule.selector).toContain(".vh-example[data-view=\"preview\"] >")
  })

  it("drops the frame around a preview of blocks marked with data-comark-frame", () => {
    for (const html of [gitGraph, bundle, issues, serverDiff, `${gitGraph}${serverDiff}`]) {
      expect(isFlush(html), html).toBe(true)
      expect(isFlush(html, "code"), html).toBe(false)
      expect(matchesAny(preview(html, "code"), "display", "none"), html).toBe(true)
    }
    expect(blocksWithoutMargin(`${gitGraph}${bundle}${issues}`)).toEqual(["cgg", "cbr", "cis"])
    expect(blocksWithoutMargin(serverDiff)).toEqual(["cd"])
  })

  it("drops the frame around blocks that frame themselves without the marker", () => {
    for (const html of ["<pre><code>pnpm dev</code></pre>", "<table></table>", "<figure><img alt=\"\"></figure>", "<div class=\"cch\"></div>", "<div class=\"ctb\"></div>"]) {
      expect(isFlush(html), html).toBe(true)
    }
  })

  it("keeps the frame around text and unmarked blocks", () => {
    for (const html of ["<p>Text</p>", "<div class=\"cgg\"></div>", `${gitGraph}<p>Text</p>`, "<div class=\"comark-html\" data-block=\"comment\"><span class=\"cr\">Note</span></div>", `<div class="comark-html" data-block="diff">${gitGraph}<p>Text</p></div>`]) {
      expect(isFlush(html), html).toBe(false)
    }
  })
})
