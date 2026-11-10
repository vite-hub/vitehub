import { AsyncLocalStorage } from "node:async_hooks"

import { describe, expect, it, vi } from "vitest"

import { matchLocale, parseAcceptLanguage, resolveI18nLocaleConfig } from "../src/locales.ts"
import { activateLocale, configureI18n, getI18n, getLocale, resolveBrowserLocale, resolveRequestLocale, setLocale, translate } from "../src/runtime.ts"
import { installI18nServer } from "../src/server.ts"
import { t } from "../src/index.ts"

const config = resolveI18nLocaleConfig({ locales: ["en", "es", "pt-BR"] })

function delayedCatalog() {
  let resolve!: (catalog: { messages: { greeting: string } }) => void
  const promise = new Promise<{ messages: { greeting: string } }>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("locale config", () => {
  it("takes the first locale as the source language", () => {
    expect(config).toEqual({ locales: ["en", "es", "pt-BR"], sourceLocale: "en", cookie: "locale" })
  })

  it("throws a config error for an empty, invalid, or repeated locale", () => {
    expect(() => resolveI18nLocaleConfig({ locales: [] })).toThrow(expect.objectContaining({ code: "I18N_INVALID_LOCALES" }))
    expect(() => resolveI18nLocaleConfig({ locales: ["en", "not a tag"] })).toThrow(expect.objectContaining({ code: "I18N_INVALID_LOCALES" }))
    expect(() => resolveI18nLocaleConfig({ locales: ["en", "EN"] })).toThrow(expect.objectContaining({ code: "I18N_INVALID_LOCALES" }))
  })
})

describe("locale matching", () => {
  it("orders Accept-Language by quality and drops q=0", () => {
    expect(parseAcceptLanguage("fr;q=0.2, es-MX, de;q=0, en;q=0.8")).toEqual(["es-MX", "en", "fr"])
  })

  it("prefers an exact tag, then the same language", () => {
    expect(matchLocale(["pt-br"], config.locales)).toBe("pt-BR")
    expect(matchLocale(["pt-PT"], config.locales)).toBe("pt-BR")
    expect(matchLocale(["es-AR"], config.locales)).toBe("es")
    expect(matchLocale(["fr", "*"], config.locales)).toBeUndefined()
  })

  it("reads the cookie before the browser languages", () => {
    const headers = (values: Record<string, string>) => new Headers(values)
    expect(resolveRequestLocale(headers({ "accept-language": "es" }), config)).toBe("es")
    expect(resolveRequestLocale(headers({ "accept-language": "es", "cookie": "locale=pt-BR" }), config)).toBe("pt-BR")
    expect(resolveRequestLocale(headers({ "cookie": "locale=xx" }), config)).toBe("en")
  })
})

describe("server scope", () => {
  it("gives concurrent requests their own locale", async () => {
    const context = new AsyncLocalStorage<object>()
    const hooks: ((event: { req: Request, context: Record<string, unknown> }) => void)[] = []
    installI18nServer({ hooks: { hook: (_name, callback) => hooks.push(callback) } }, {
      config: { ...config, catalogs: {} },
      messages: { en: {}, es: { greeting: "Hola" }, "pt-BR": { greeting: "Olá" } },
      current: () => context.getStore(),
    })
    const handle = (language: string) => {
      const event = { req: new Request("http://app.test/", { headers: { "accept-language": language } }), context: {} }
      return context.run(event, async () => {
        for (const hook of hooks) hook(event)
        await new Promise(resolve => setTimeout(resolve, Math.random() * 10))
        return `${getLocale()}:${translate({ id: "greeting", message: "Hello" })}`
      })
    }
    // `setLocale()` in a route switches only that request, with the compiled messages of the locale.
    const switched = { req: new Request("http://app.test/"), context: {} }
    expect(await context.run(switched, async () => {
      for (const hook of hooks) hook(switched)
      await setLocale("es")
      return `${getLocale()}:${translate({ id: "greeting", message: "Hello" })}`
    })).toBe("es:Hola")
    const languages = Array.from({ length: 30 }, (_, index) => ["en", "es", "pt-BR"][index % 3]!)
    expect(await Promise.all(languages.map(handle))).toEqual(languages.map(language => `${language}:${{ en: "Hello", es: "Hola", "pt-BR": "Olá" }[language]}`))

    // Server code keeps the source text. In production, Lingui has no compiler of its own, so the server adds one.
    const nodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    const untranslated = { req: new Request("http://app.test/", { headers: { "accept-language": "es" } }), context: {} }
    expect(context.run(untranslated, () => {
      for (const hook of hooks) hook(untranslated)
      return translate({ id: "missing", message: "{count, plural, one {# agent} other {# agents}}", values: { count: 2 } })
    })).toBe("2 agents")
    process.env.NODE_ENV = nodeEnv
    // Independent requests can change locale concurrently without superseding each other.
    const switchRequest = (language: string) => {
      const event = { req: new Request("http://app.test/"), context: {} }
      return context.run(event, async () => {
        for (const hook of hooks) hook(event)
        await setLocale(language)
        return `${getLocale()}:${translate({ id: "greeting", message: "Hello" })}`
      })
    }
    expect(await Promise.all([switchRequest("es"), switchRequest("pt-BR")])).toEqual(["es:Hola", "pt-BR:Olá"])
  })
})

describe("runtime", () => {
  it.each([
    { cookie: "locale=es", languages: ["en"], locale: "es" },
    { cookie: "", languages: ["es-MX"], locale: "es" },
    { cookie: "", languages: ["fr"], locale: "en" },
  ])("sets the initial document language to $locale for $cookie and $languages", async ({ cookie, languages, locale }) => {
    configureI18n({ ...config, catalogs: { es: async () => ({ messages: { greeting: "Hola" } }) } })
    const page = { cookie, documentElement: { lang: "en" } }
    vi.stubGlobal("document", page)
    vi.stubGlobal("navigator", { languages })
    try {
      // `createI18n()` initializes a Vite app with this browser selection and activation.
      await activateLocale(getI18n(), resolveBrowserLocale(config))
      expect(getLocale()).toBe(locale)
      expect(translate({ id: "greeting", message: "Hello" })).toBe(locale === "es" ? "Hola" : "Hello")
      expect(page.documentElement.lang).toBe(locale)
      expect(page.cookie).toBe(cookie)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it("keeps the latest locale selection when an earlier catalog loads last", async () => {
    const spanish = delayedCatalog()
    const portuguese = delayedCatalog()
    configureI18n({
      ...config,
      catalogs: { es: () => spanish.promise, "pt-BR": () => portuguese.promise },
    })
    const page = { cookie: "", documentElement: { lang: "en" } }
    vi.stubGlobal("document", page)
    try {
      const earlier = setLocale("es")
      const latest = setLocale("pt-BR")
      portuguese.resolve({ messages: { greeting: "Olá" } })
      expect(await latest).toEqual([undefined, "pt-BR"])
      expect(getLocale()).toBe("pt-BR")
      const cookie = page.cookie
      expect(cookie).toContain("locale=pt-BR;")
      spanish.resolve({ messages: { greeting: "Hola" } })
      const [error, locale] = await earlier
      expect(locale).toBeUndefined()
      expect(error).toMatchObject({ code: "I18N_LOCALE_SUPERSEDED", docs: "https://vitehub.dev/docs/i18n/diagnostics/i18n_locale_superseded" })
      expect(getLocale()).toBe("pt-BR")
      expect(translate({ id: "greeting" })).toBe("Olá")
      expect(page.cookie).toBe(cookie)
      expect(page.documentElement.lang).toBe("pt-BR")
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it("returns an error result for a locale that the app does not configure", async () => {
    const [error, locale] = await setLocale("fr")
    expect(locale).toBeUndefined()
    expect(error).toMatchObject({ code: "I18N_UNKNOWN_LOCALE", docs: "https://vitehub.dev/docs/i18n/diagnostics/i18n_unknown_locale" })
  })

  it("throws a clear error when a macro runs without the build", () => {
    expect(() => t`Hello`).toThrow(expect.objectContaining({ code: "I18N_MACRO_NOT_COMPILED" }))
  })
})
