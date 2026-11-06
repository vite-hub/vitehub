import { AsyncLocalStorage } from "node:async_hooks"

import { describe, expect, it } from "vitest"

import { matchLocale, parseAcceptLanguage, resolveI18nLocaleConfig } from "../src/locales.ts"
import { getLocale, resolveRequestLocale, setLocale, translate } from "../src/runtime.ts"
import { installI18nServer } from "../src/server.ts"
import { t } from "../src/index.ts"

const config = resolveI18nLocaleConfig({ locales: ["en", "es", "pt-BR"] })

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
    const languages = Array.from({ length: 30 }, (_, index) => ["en", "es", "pt-BR"][index % 3]!)
    expect(await Promise.all(languages.map(handle))).toEqual(languages.map(language => `${language}:${{ en: "Hello", es: "Hola", "pt-BR": "Olá" }[language]}`))
  })
})

describe("runtime", () => {
  it("returns an error result for a locale that the app does not configure", async () => {
    const [error, locale] = await setLocale("fr")
    expect(locale).toBeUndefined()
    expect(error).toMatchObject({ code: "I18N_UNKNOWN_LOCALE", docs: "https://vitehub.dev/docs/i18n/limits-and-errors#i18n_unknown_locale" })
  })

  it("throws a clear error when a macro runs without the build", () => {
    expect(() => t`Hello`).toThrow(expect.objectContaining({ code: "I18N_MACRO_NOT_COMPILED" }))
  })
})
