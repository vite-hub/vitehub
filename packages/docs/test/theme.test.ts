import { describe, expect, it } from "vitest"

import { docsAppConfigUi, docsThemeAdditions, docsThemeScope, vercelTheme } from "../src/theme.ts"

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

describe("docsThemeScope", () => {
  const scope = docsThemeScope(vercelTheme("Acme"))

  it("gives <UTheme> the slot classes and default props, and leaves colors and icons to the app", () => {
    expect(scope.ui).not.toHaveProperty("colors")
    expect(scope.ui).not.toHaveProperty("icons")
    expect(scope.ui.header).toMatchObject({ root: expect.stringContaining("h-[44px]") })
    expect(scope.props.contentNavigation).toEqual({ variant: "link", color: "neutral" })
    expect(scope.props.header).toEqual({ menu: { title: "Navigation", description: "Acme site navigation" } })
  })

  it("reads the base class of one-element components and nests the prose components", () => {
    expect(scope.ui.pageBody).toEqual({ base: expect.stringContaining("pb-24") })
    expect(scope.ui.prose).toMatchObject({ a: { base: expect.stringContaining("underline") }, h2: { base: expect.stringContaining("text-2xl/8") } })
    expect(scope.ui.prose).not.toHaveProperty("codeIcon")
  })
})

describe("docsThemeAdditions", () => {
  it("adds only the code block icons to an app with its own app.vue", () => {
    expect(docsThemeAdditions(vercelTheme("Acme"))).toEqual({ prose: { codeIcon: expect.objectContaining({ js: "i-vscode-icons-file-type-js-official" }) } })
  })
})
