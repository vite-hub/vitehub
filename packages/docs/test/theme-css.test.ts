import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

import postcss from "postcss"
import { describe, expect, it } from "vitest"

import { docsThemeCss } from "../src/theme-css.ts"

const themeUrl = import.meta.resolve("@vite-hub/ui/theme.css")
const file = fileURLToPath(themeUrl)

describe("the design system inside an app", () => {
  it("keeps every shared selector, including imported focus rules and system dark mode, on docs pages", () => {
    const css = postcss.parse(docsThemeCss(file))
    const selectors: string[] = []
    css.walkRules(rule => { selectors.push(...rule.selectors) })

    expect(selectors.length).toBeGreaterThan(20)
    expect(selectors.every(selector => selector.includes(":where(.vh-docs)"))).toBe(true)
    expect(selectors).toContain(":root:where(.vh-docs):not(.light):not(.dark)")
    expect(selectors).toContain(":where(.vh-docs) :focus-visible")
    expect(selectors).toContain(":where(.vh-docs) ::selection")
    const imports: string[] = []
    css.walkAtRules("import", rule => { imports.push(rule.params) })
    expect(imports).toEqual([])
  })

  it("keeps font values on the docs root without changing Tailwind's theme or the app's primary", () => {
    const css = postcss.parse(docsThemeCss(file))
    const fonts: Array<{ selector: string, value: string }> = []
    css.walkDecls("--font-sans", (declaration) => {
      const rule = declaration.parent
      if (rule?.type === "rule") fonts.push({ selector: rule.selector, value: declaration.value })
    })
    expect(fonts).toEqual([{ selector: ":root:where(.vh-docs)", value: expect.stringContaining('"Geist"') }])
    const themes: string[] = []
    css.walkAtRules("theme", rule => { themes.push(rule.params) })
    expect(themes).toEqual([])
    const primary: string[] = []
    css.walkDecls("--ui-primary", declaration => { primary.push(declaration.value) })
    expect(primary).toEqual([])
  })

  it("scans the shared component classes from the generated stylesheet's location", () => {
    const sources: string[] = []
    postcss.parse(docsThemeCss(file)).walkAtRules("source", rule => { sources.push(JSON.parse(rule.params)) })

    expect(sources).toEqual([fileURLToPath(new URL("./theme.js", themeUrl))])
    expect(sources.every(source => existsSync(source))).toBe(true)
  })
})
