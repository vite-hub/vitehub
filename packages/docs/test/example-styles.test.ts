import { readFileSync } from "node:fs"

import postcss from "postcss"
import { describe, expect, it } from "vitest"
import { compileStyle, parse } from "vue/compiler-sfc"

const source = readFileSync(new URL("../runtime/app/components/content/Example.vue", import.meta.url), "utf8")
const [style] = parse(source).descriptor.styles
const css = compileStyle({ source: style!.content, id: "data-v-example", scoped: style!.scoped, filename: "Example.vue" }).code

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

describe("Example.vue styles", () => {
  it("shows the preview only in the Preview view", () => {
    const displays = previewDisplays()
    expect(displays).toContainEqual({ selector: expect.stringContaining(".vh-example[data-view=\"code\"]"), display: "none" })
    const shown = displays.filter(rule => rule.display !== "none")
    expect(shown.length).toBeGreaterThan(0)
    for (const rule of shown) expect(rule.selector).toContain(".vh-example[data-view=\"preview\"] >")
  })
})
