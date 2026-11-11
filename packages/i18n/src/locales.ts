import { i18nErrorDiagnostics } from "./errors.ts"

/** The `i18n` option of `vitehub()` and `vite-hub/nuxt`. */
export interface I18nOptions {
  /**
   * Locales of the app, as BCP 47 tags. The first one is the source locale: the language that you write in the code.
   * @example ["en", "es", "de"]
   */
  locales: readonly string[]
  /**
   * Cookie that stores the locale that a user picks with `setLocale()`.
   * @default "locale"
   */
  cookie?: string
  /**
   * Name of a Workspace with retained history that stores the translations. The server reads its `published` ref,
   * so a published translation is live without a deploy. Without it, translations are records in `locales/<locale>/`.
   * @example "translations"
   */
  workspace?: string
}

/** The resolved locale settings that the runtime gets. */
export interface I18nLocaleConfig {
  locales: readonly string[]
  sourceLocale: string
  cookie: string
}

export function resolveI18nLocaleConfig(options: I18nOptions): I18nLocaleConfig {
  const locales = Array.isArray(options?.locales) ? options.locales : []
  if (locales.length === 0) throw i18nErrorDiagnostics.I18N_INVALID_LOCALES({ problem: "`i18n.locales` is empty." })
  const seen = new Set<string>()
  for (const locale of locales) {
    if (typeof locale !== "string" || !isLocaleTag(locale)) throw i18nErrorDiagnostics.I18N_INVALID_LOCALES({ problem: `\`${String(locale)}\` is not a BCP 47 language tag.` })
    if (seen.has(locale.toLowerCase())) throw i18nErrorDiagnostics.I18N_INVALID_LOCALES({ problem: `\`${locale}\` is listed twice.` })
    seen.add(locale.toLowerCase())
  }
  return { locales: [...locales], sourceLocale: locales[0]!, cookie: options.cookie || "locale" }
}

function isLocaleTag(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1
  }
  catch {
    return false
  }
}

/**
 * Pick the best configured locale for a list of preferred languages, such as the `Accept-Language` header or
 * `navigator.languages`. An exact tag wins, then the same language (`es-MX` matches `es`).
 */
export function matchLocale(preferred: readonly string[], locales: readonly string[]): string | undefined {
  const lower = locales.map(locale => locale.toLowerCase())
  for (const wanted of preferred) {
    const tag = wanted.trim().toLowerCase()
    if (!tag || tag === "*") continue
    const exact = lower.indexOf(tag)
    if (exact !== -1) return locales[exact]
    const language = tag.split("-")[0]
    const partial = lower.findIndex(locale => locale === language || locale.split("-")[0] === language)
    if (partial !== -1) return locales[partial]
  }
  return undefined
}

/** Parse an `Accept-Language` header into tags, best first. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return []
  return header.split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";")
      const q = params.map(param => param.trim()).find(param => param.startsWith("q="))
      const quality = q ? Number(q.slice(2)) : 1
      return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0, index }
    })
    .filter(entry => entry.tag && entry.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index)
    .map(entry => entry.tag)
}

/** Read one cookie value from a `Cookie` header or `document.cookie`. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index === -1) continue
    if (part.slice(0, index).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(index + 1).trim())
    }
    catch {
      return undefined
    }
  }
  return undefined
}
