import { setupI18n } from "@lingui/core"

import { i18nErrorDiagnostics } from "./errors.ts"
import { matchLocale, parseAcceptLanguage, readCookie } from "./locales.ts"

import type { I18n, MessageDescriptor, Messages } from "@lingui/core"
import type { Result } from "@vite-hub/runtime"
import type { I18nLocaleConfig } from "./locales.ts"

export type { I18n, Messages } from "@lingui/core"
export type { I18nLocaleConfig } from "./locales.ts"

/** Loads the compiled messages of one locale. The build generates one loader for each locale. */
export type I18nCatalogLoader = () => Promise<{ messages: Messages }>

export interface I18nRuntimeConfig extends I18nLocaleConfig {
  catalogs: Readonly<Record<string, I18nCatalogLoader>>
  /** Path of the live catalog route, such as `/_vitehub/i18n`, when a Workspace stores the translations. */
  live?: string
}

interface I18nState {
  config?: I18nRuntimeConfig
  app?: I18n
  scope?: () => I18n | undefined
  /** Set by the Vue plugin. A message read inside `computed` or a render then re-runs after a locale change. */
  track?: () => void
}

// One state per JavaScript realm, so the build output and linked copies of this package share it.
const stateKey = Symbol.for("vite-hub.i18n.state")

function state(): I18nState {
  const scope = globalThis as typeof globalThis & { [stateKey]?: I18nState }
  return scope[stateKey] ||= {}
}

/** Called by the generated client and server entries with the locales and catalogs of the app. */
export function configureI18n(config: I18nRuntimeConfig): void {
  state().config = config
}

export function getI18nConfig(): I18nRuntimeConfig | undefined {
  return state().config
}

/** The Vue plugin sets a tracker, so reactive code that translates a message depends on the locale. */
export function setI18nTracker(track: (() => void) | undefined): void {
  state().track = track
}

/** The server sets a scope so that each request reads its own locale. */
export function setI18nScope(scope: (() => I18n | undefined) | undefined): void {
  state().scope = scope
}

/** The i18n instance of the current request on the server, or of the page in the browser. */
export function getI18n(): I18n {
  const current = state()
  const scoped = current.scope?.()
  if (scoped) return scoped
  if (!current.app) {
    const locale = current.config?.sourceLocale ?? "en"
    current.app = setupI18n({ locale, messages: { [locale]: {} } })
  }
  return current.app
}

/**
 * The object that compiled messages call. It forwards to the instance of the current request, so a message in
 * shared server code reads the locale of the request that runs it.
 */
// SAFETY: Every property read forwards to a real I18n instance.
export const i18n: I18n = new Proxy({} as I18n, {
  get(_target, key) {
    state().track?.()
    const target = getI18n()
    const value: unknown = Reflect.get(target, key, target)
    return typeof value === "function" ? value.bind(target) : value
  },
})

/** The active locale, such as `"es"`. On the server it is the locale of the current request. */
export function getLocale(): string {
  return getI18n().locale || state().config?.sourceLocale || "en"
}

/** The configured locales. The first one is the source locale. */
export function getLocales(): readonly string[] {
  return state().config?.locales ?? [getLocale()]
}

/**
 * Translations that a Workspace published after the build. The route answers with an ETag, so the browser downloads a
 * catalog again only after a publish. When the route fails, the page keeps the catalog of the build.
 */
async function liveMessages(live: string, locale: string): Promise<Messages> {
  try {
    const response = await fetch(`${live}/${encodeURIComponent(locale)}.json`)
    if (!response.ok) return {}
    const body = await response.json() as { revision?: string, messages?: Messages }
    return body.revision === "build" ? {} : body.messages ?? {}
  }
  catch {
    return {}
  }
}

/** Load the compiled messages of a locale and activate it on an i18n instance. */
export async function activateLocale(target: I18n, locale: string): Promise<void> {
  const config = state().config
  const loader = config?.catalogs[locale]
  const [{ messages }, live] = await Promise.all([
    loader ? loader() : { messages: {} },
    config?.live && browserDocument() ? liveMessages(config.live, locale) : {},
  ])
  target.loadAndActivate({ locale, messages: { ...messages, ...live } })
}

/** The parts of `document` that the runtime uses. Server code has no `document`. */
interface BrowserDocument {
  cookie: string
  documentElement: { lang: string }
}

function browserDocument(): BrowserDocument | undefined {
  return (globalThis as { document?: BrowserDocument }).document
}

/** The locale that the browser should start with: the saved cookie, then the browser languages, then the source locale. */
export function resolveBrowserLocale(config: I18nLocaleConfig): string {
  const page = browserDocument()
  const cookie = page ? readCookie(page.cookie, config.cookie) : undefined
  const languages = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]
  return (cookie && matchLocale([cookie], config.locales))
    || matchLocale(languages, config.locales)
    || config.sourceLocale
}

/** The locale for a request: the cookie that `setLocale()` wrote, then `Accept-Language`, then the source locale. */
export function resolveRequestLocale(headers: { get(name: string): string | null }, config: I18nLocaleConfig): string {
  const picked = readCookie(headers.get("cookie"), config.cookie)
  return (picked && matchLocale([picked], config.locales))
    || matchLocale(parseAcceptLanguage(headers.get("accept-language")), config.locales)
    || config.sourceLocale
}

/**
 * Switch the page to another locale. It loads the catalog, re-renders the messages, and saves the choice in a
 * cookie, so the next server render uses it too.
 */
export async function setLocale(locale: string): Promise<Result<string, "I18N_UNKNOWN_LOCALE">> {
  const config = state().config
  const locales = config?.locales ?? []
  const match = locales.find(entry => entry.toLowerCase() === locale.toLowerCase())
  if (!config || !match) return [i18nErrorDiagnostics.I18N_UNKNOWN_LOCALE({ locale, locales }), undefined]
  await activateLocale(getI18n(), match)
  const page = browserDocument()
  if (page) {
    page.cookie = `${config.cookie}=${encodeURIComponent(match)}; Path=/; Max-Age=31536000; SameSite=Lax`
    page.documentElement.lang = match
  }
  return [undefined, match]
}

/** Translate a message that `msg` declared, in the active locale. */
export function translate(descriptor: MessageDescriptor): string {
  state().track?.()
  return getI18n()._(descriptor)
}
