import { setupI18n } from "@lingui/core"

import { configureI18n, resolveRequestLocale, setI18nScope } from "./runtime.ts"

import type { I18n, Messages } from "@lingui/core"
import type { I18nRuntimeConfig } from "./runtime.ts"

type HeaderBag = { get(name: string): string | null }

/** The parts of an H3 1 or H3 2 event that the server scope reads. */
interface RequestEvent {
  context?: Record<string, unknown>
  req?: { headers?: HeaderBag } | unknown
  node?: { req?: { headers?: Record<string, string | string[] | undefined> } }
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

function requestHeaders(event: RequestEvent): HeaderBag {
  const headers = (event.req as { headers?: unknown } | undefined)?.headers
  if (headers && typeof (headers as HeaderBag).get === "function") return headers as HeaderBag
  const node = event.node?.req?.headers ?? {}
  return {
    get: (name) => {
      const value = node[name.toLowerCase()]
      return Array.isArray(value) ? value.join(", ") : value ?? null
    },
  }
}

/**
 * Give each request its own i18n instance. Nitro's async context finds the request that runs a message, so
 * server code calls `t` without passing the event.
 */
export function installI18nServer(nitroApp: NitroAppLike, options: I18nServerOptions): void {
  configureI18n(options.config)
  const byRequest = new WeakMap<object, I18n>()
  const create = (locale: string): I18n => setupI18n({ locale, messages: { [locale]: options.messages[locale] ?? {} } })

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
