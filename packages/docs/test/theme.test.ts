import { describe, expect, it } from "vitest"

import { docsAppConfigUi, vercelTheme } from "../src/theme.ts"

// What `nuxt.options.appConfig.ui` holds after Nuxt UI ran first and added its defaults.
const nuxtUiDefaults = { colors: { primary: "green", secondary: "blue", neutral: "slate" }, icons: { light: "i-lucide-sun", copy: "i-lucide-copy" } }

describe("docsAppConfigUi", () => {
  it("keeps the theme colors when Nuxt UI added its defaults first", () => {
    const ui = docsAppConfigUi(vercelTheme("Docs"), nuxtUiDefaults, [undefined])

    expect(ui.colors).toEqual({ primary: "neutral", secondary: "blue", neutral: "zinc", warning: "amber" })
    expect(ui.icons).toMatchObject({ light: "i-ph-sun-light", copy: "i-lucide-copy" })
  })

  it("lets the app's Nuxt config win over the theme", () => {
    const ui = docsAppConfigUi(vercelTheme("Docs"), { ...nuxtUiDefaults, colors: { ...nuxtUiDefaults.colors, primary: "blue" } }, [{ colors: { primary: "blue" } }])

    expect(ui.colors).toMatchObject({ primary: "blue", neutral: "zinc" })
  })
})
