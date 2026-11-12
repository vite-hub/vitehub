import { vitehubTheme } from "@vite-hub/ui/theme"
import { describe, expect, it } from "vitest"

import { docsAppConfigUi, docsThemeAdditions, docsThemeScope, docsUi } from "../src/theme.ts"

// What `nuxt.options.appConfig.ui` holds after Nuxt UI ran first and added its defaults.
const nuxtUiDefaults = { colors: { primary: "green", secondary: "blue", neutral: "slate" }, icons: { light: "i-lucide-sun", copy: "i-lucide-copy", search: "i-lucide-search" } }

describe("docsAppConfigUi", () => {
  it("keeps the design system colors and icons when Nuxt UI added its defaults first", () => {
    const ui = docsAppConfigUi(docsUi("Docs"), nuxtUiDefaults, [undefined])

    expect(ui.colors).toEqual({ ...vitehubTheme.colors, secondary: "blue" })
    expect(ui.icons).toEqual(vitehubTheme.icons)
  })

  it("lets the app's Nuxt config win over the design", () => {
    const ui = docsAppConfigUi(docsUi("Docs"), { ...nuxtUiDefaults, colors: { ...nuxtUiDefaults.colors, primary: "blue" } }, [{ colors: { primary: "blue" } }])

    expect(ui.colors).toMatchObject({ primary: "blue", neutral: "neutral" })
  })
})

describe("docsThemeScope", () => {
  const scope = docsThemeScope(docsUi("Acme"))

  it("gives <UTheme> the slot classes and default props, and leaves colors and icons to the app", () => {
    expect(scope.ui).not.toHaveProperty("colors")
    expect(scope.ui).not.toHaveProperty("icons")
    expect(scope.ui.header).toMatchObject({ root: expect.stringContaining("h-(--ui-header-height)") })
    expect(scope.props.contentNavigation).toEqual({ variant: "link", color: "neutral" })
    expect(scope.props.header).toEqual({ menu: { title: "Navigation", description: "Acme site navigation" } })
  })

  it("reads the base class of one-element components and nests the prose components", () => {
    expect(scope.ui.pageBody).toEqual({ base: expect.stringContaining("pb-24") })
    expect(scope.ui.prose).toMatchObject({ a: { base: expect.stringContaining("underline") }, h2: { base: expect.stringContaining("border-t") } })
    expect(scope.ui.prose).not.toHaveProperty("codeIcon")
  })
})

describe("docsThemeAdditions", () => {
  it("adds only the code block icons to an app with its own app.vue", () => {
    expect(docsThemeAdditions(docsUi("Acme"))).toEqual({ prose: { codeIcon: expect.objectContaining({ js: "i-vscode-icons-file-type-js-official" }) } })
  })
})

describe("docsUi", () => {
  it("styles components the docs share with the Console through the design system", () => {
    const ui = docsUi("Docs")

    expect(ui.tabs).toEqual(vitehubTheme.tabs)
    expect(ui.button).toEqual(vitehubTheme.button)
    expect(ui.pageCard).toEqual(vitehubTheme.pageCard)
  })

  it("adds only shell slots, without square corners or focus styles", () => {
    const shell = JSON.stringify(Object.entries(docsUi("Docs")).filter(([key]) => !(key in vitehubTheme)))

    expect(shell).not.toMatch(/rounded-(none|sm)\b/)
    expect(shell).not.toMatch(/focus(-visible)?:(outline|ring)/)
    expect(shell).not.toMatch(/\bi-ph-/)
  })
})
