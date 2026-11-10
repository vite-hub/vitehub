import { setupI18n } from "@lingui/core"
import { compileMessage } from "@lingui/message-utils/compileMessage"

import { configureI18n, resolveRequestLocale, setI18nScope } from "./runtime.ts"

import type { I18n, Messages } from "@lingui/core"
import type { I18nRuntimeConfig } from "./runtime.ts"

type HeaderBag = { get(name: string): string | null }

/** The parts of an H3 2 event that the server scope reads. */
interface RequestEvent {
  context?: Record<string, unknown>
  req?: { headers?: HeaderBag } | unknown
}

interface NitroAppLike {
  hooks: { hook(name: "request", callback: (event: RequestEvent) => void): unknown }
}

export interface I18nServerOptions {
  config: I18nRuntimeConfig
  /** Compiled messages of every locale. The server loads them all, so a request never waits for a catalog. */
  messages: Readonly<Record<string, Messages>>
  /** Returns the event or request of the current request from Nitro's async context. */
  current: () => unknown
}

const eventKey = "vitehubI18n"

const noHeaders: HeaderBag = { get: () => null }

function requestHeaders(event: RequestEvent): HeaderBag {
  const headers = (event.req as { headers?: unknown } | undefined)?.headers
  return headers && typeof (headers as HeaderBag).get === "function" ? headers as HeaderBag : noHeaders
}

/**
 * Give each request its own i18n instance. Nitro's async context finds the request that runs a message, so
 * server code calls `t` without passing the event.
 */
export function installI18nServer(nitroApp: NitroAppLike, options: I18nServerOptions): void {
  // `setLocale()` in server code switches the request instance, so it loads from the compiled messages.
  const catalogs = Object.fromEntries(options.config.locales.map(locale => [locale, async () => ({ messages: options.messages[locale] ?? {} })]))
  configureI18n({ ...options.config, catalogs })
  const byRequest = new WeakMap<object, I18n>()
  // Server code keeps the source text of each message. A message without a translation compiles it once here.
  const compiled = new Map<string, ReturnType<typeof compileMessage>>()
  const compile = (message: string) => {
    let result = compiled.get(message)
    if (!result) compiled.set(message, result = compileMessage(message))
    return result
  }
  const create = (locale: string): I18n => {
    const instance = setupI18n({ locale, messages: { [locale]: options.messages[locale] ?? {} } })
    instance.setMessagesCompiler(compile)
    return instance
  }

  nitroApp.hooks.hook("request", (event) => {
    const instance = create(resolveRequestLocale(requestHeaders(event), options.config))
    if (event.context) event.context[eventKey] = instance
    if (event.req && typeof event.req === "object") byRequest.set(event.req, instance)
    byRequest.set(event, instance)
  })

  setI18nScope(() => {
    const current = options.current()
    if (!current || typeof current !== "object") return undefined
    return byRequest.get(current) ?? (current as RequestEvent).context?.[eventKey] as I18n | undefined
  })
}

/** The i18n instance that the server created for a request event. */
export function getRequestI18n(event: unknown): I18n | undefined {
  return (event as RequestEvent | undefined)?.context?.[eventKey] as I18n | undefined
}
