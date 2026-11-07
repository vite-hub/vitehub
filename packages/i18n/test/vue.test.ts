import { setupI18n } from "@lingui/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSSRApp } from "vue"

import { resolveI18nLocaleConfig } from "../src/locales.ts"
import { configureI18n, getI18n } from "../src/runtime.ts"
import { i18nPlugin, useLocale } from "../src/vue.ts"

vi.mock("virtual:vite-hub/i18n/client", () => ({}))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Vue locale state", () => {
  it("switches the plugin instance without changing another app or the runtime instance", async () => {
    configureI18n({
      ...resolveI18nLocaleConfig({ locales: ["en", "es"] }),
      catalogs: { es: async () => ({ messages: { greeting: "Hola" } }) },
    })
    const runtime = getI18n()
    const runtimeLocale = runtime.locale
    const first = setupI18n({ locale: "en", messages: { en: { greeting: "Hello" } } })
    const second = setupI18n({ locale: "en", messages: { en: { greeting: "Hello" } } })
    const firstApp = createSSRApp({}).use(i18nPlugin({ i18n: first }))
    const secondApp = createSSRApp({}).use(i18nPlugin({ i18n: second }))
    const firstState = firstApp.runWithContext(useLocale)
    const secondState = secondApp.runWithContext(useLocale)
    const page = { cookie: "", documentElement: { lang: "en" } }
    vi.stubGlobal("document", page)

    expect(await firstState.setLocale("ES")).toEqual([undefined, "es"])
    expect(firstState.locale.value).toBe("es")
    expect(first._("greeting")).toBe("Hola")
    expect(page.cookie).toContain("locale=es;")
    expect(page.documentElement.lang).toBe("es")
    expect(secondState.locale.value).toBe("en")
    expect(second._("greeting")).toBe("Hello")
    expect(runtime.locale).toBe(runtimeLocale)
  })
})
