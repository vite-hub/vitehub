import { vitehubTheme } from "@vite-hub/ui/theme"
import { describe, expect, it } from "vitest"

import { docsAppConfigUi, docsTheme } from "../src/theme.ts"

// What `nuxt.options.appConfig.ui` holds after Nuxt UI ran first and added its defaults.
const nuxtUiDefaults = { colors: { primary: "green", secondary: "blue", neutral: "slate" }, icons: { light: "i-lucide-sun", copy: "i-lucide-copy", search: "i-lucide-search" } }

describe("docsAppConfigUi", () => {
  it("keeps the design system colors and icons when Nuxt UI added its defaults first", () => {
    const ui = docsAppConfigUi(docsTheme("Docs"), nuxtUiDefaults, [undefined])

    expect(ui.colors).toEqual({ ...vitehubTheme.colors, secondary: "blue" })
    expect(ui.icons).toEqual(vitehubTheme.icons)
  })

  it("lets the app's Nuxt config win over the theme", () => {
    const ui = docsAppConfigUi(docsTheme("Docs"), { ...nuxtUiDefaults, colors: { ...nuxtUiDefaults.colors, primary: "blue" } }, [{ colors: { primary: "blue" } }])

    expect(ui.colors).toMatchObject({ primary: "blue", neutral: "neutral" })
  })
})

describe("docsTheme", () => {
  it("styles components the docs share with the Console through the design system", () => {
    const ui = docsTheme("Docs")

    expect(ui.tabs).toEqual(vitehubTheme.tabs)
    expect(ui.button).toEqual(vitehubTheme.button)
    expect(ui.pageCard).toEqual(vitehubTheme.pageCard)
  })

  it("adds only shell slots, without square corners or focus styles", () => {
    const shell = JSON.stringify(Object.entries(docsTheme("Docs")).filter(([key]) => !(key in vitehubTheme)))

    expect(shell).not.toMatch(/rounded-(none|sm)\b/)
    expect(shell).not.toMatch(/focus(-visible)?:(outline|ring)/)
    expect(shell).not.toMatch(/\bi-ph-/)
  })
})
