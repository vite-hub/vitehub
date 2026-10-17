import { addCacheBypass } from "@vite-hub/internal/runtime/cache-bypass"
import { defineGrant } from "@vite-hub/runtime/internal/grant"

import { contentErrorDiagnostics } from "./error-diagnostics.ts"

/** Name of the cookie that carries the Content preview token. */
export const contentPreviewCookieName = "vitehub-content-preview"

/** Server Env variable with the Content signing key: 32 random bytes as base64 or hex. */
export const contentKeyVariable = "VITEHUB_CONTENT_KEY"

const defaultMaxAge = 60 * 60
const minimumMaxAge = 60
const maximumMaxAge = 24 * 60 * 60
const tokenVersion = "v1"
// Domain separation: the key may sign other Content values later.
const tokenPurpose = "vitehub.content.preview"
const tokenPattern = /^v1\.(\d{1,12})\.([\w-]{43})$/

type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>

/**
 * A request that `content.preview` reads cookies from and writes `Set-Cookie` to: an H3 event (Nitro 3 or Nitro 2)
 * or a Web `Request`. A `Request` has no response, so read the returned `setCookie` instead.
 */
export type ContentPreviewEvent = Request | {
  req?: unknown
  res?: unknown
  node?: unknown
  headers?: unknown
  url?: unknown
}

export interface ContentPreviewOptions {
  /** Seconds the token and cookie stay valid. Default 3600 (one hour), from 60 to 86400. */
  maxAge?: number
}

export interface ContentPreviewCookie {
  /** The `Set-Cookie` header value. `enable()` and `disable()` already append it to an event response. */
  setCookie: string
  /** When the preview token expires, or null after `disable()`. */
  expiresAt: Date | null
}

/**
 * Draft preview for one Content runtime. A request with a valid preview cookie reads the `draft` ref through every
 * Content read: `/api/content/**`, `content.get()`, `list()`, `navigation()`, `search()`, and collection `get()`/`list()`.
 */
export interface ContentPreview {
  /**
   * Sign a preview token and set it as an `HttpOnly`, `SameSite=Strict` cookie on the event response. This is trusted
   * server API: check `content.can({ user, collection, action: "read" })` before calling it. The token previews every
   * collection of this runtime until it expires.
   */
  enable(event: ContentPreviewEvent, options?: ContentPreviewOptions): Promise<ContentPreviewCookie>
  /** Clear the preview cookie. Later requests read `published` again. */
  disable(event: ContentPreviewEvent): ContentPreviewCookie
  /**
   * Run `callback` with the event's preview grant when its cookie holds a valid token, and mark the response
   * `Cache-Control: private, no-store`. Without a valid token `callback` runs unchanged. In a ViteHub app the generated
   * Nitro plugin and `/api/content/**` call it for you; call it yourself for requests that do not go through Nitro.
   */
  run<TResult>(event: ContentPreviewEvent, callback: () => TResult | Promise<TResult>): Promise<TResult>
  /** Whether Content reads in the current request use the `draft` ref. */
  active(): boolean
}

type HeaderBag = { get?: unknown, append?: unknown, set?: unknown, [name: string]: unknown }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!isObject(headers)) return
  const bag: HeaderBag = headers
  if (bag.get instanceof Function) {
    const value: unknown = Reflect.apply(bag.get, headers, [name])
    return String(value) === value ? value : undefined
  }
  const value = bag[name]
  if (Array.isArray(value)) return value.join(name === "cookie" ? "; " : ", ")
  return String(value) === value ? value : undefined
}

function eventParts(event: ContentPreviewEvent) {
  if (event instanceof Request) return { request: event, response: undefined, node: undefined, headers: event.headers, url: event.url }
  const node = isObject(event.node) ? event.node : undefined
  const nodeRequest = isObject(node?.req) ? node.req : undefined
  const request = isObject(event.req) ? event.req : undefined
  return {
    request,
    response: isObject(event.res) ? event.res : undefined,
    node: isObject(node?.res) ? node.res : undefined,
    headers: request?.headers ?? event.headers ?? nodeRequest?.headers,
    url: event.url ?? request?.url ?? nodeRequest?.url,
    encrypted: isObject(nodeRequest?.socket) ? nodeRequest.socket.encrypted === true : undefined,
  }
}

function requestHeader(event: ContentPreviewEvent, name: string): string | undefined {
  return readHeader(eventParts(event).headers, name)
}

/** HTTPS unless the request says it is plain HTTP. An unknown protocol keeps `Secure`. */
function secureRequest(event: ContentPreviewEvent): boolean {
  const forwarded = requestHeader(event, "x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase()
  if (forwarded) return forwarded !== "http"
  const parts = eventParts(event)
  const url = String(parts.url)
  if (/^https:/i.test(url)) return true
  if (/^http:/i.test(url)) return false
  if ("encrypted" in parts && parts.encrypted !== undefined) return parts.encrypted
  return true
}

function appendResponseHeader(event: ContentPreviewEvent, name: string, value: string, mode: "append" | "set"): void {
  const parts = eventParts(event)
  const headers = parts.response?.headers
  if (isObject(headers) && headers.append instanceof Function && headers.set instanceof Function) {
    Reflect.apply(mode === "append" ? headers.append : headers.set, headers, [name, value])
    return
  }
  const response = parts.node
  if (!response || response.headersSent === true || !(response.setHeader instanceof Function)) return
  if (mode === "set") {
    Reflect.apply(response.setHeader, response, [name, value])
    return
  }
  if (response.appendHeader instanceof Function) {
    Reflect.apply(response.appendHeader, response, [name, value])
    return
  }
  const previous: unknown = response.getHeader instanceof Function ? Reflect.apply(response.getHeader, response, [name]) : undefined
  const values = Array.isArray(previous) ? previous.map(String) : previous === undefined ? [] : [String(previous)]
  Reflect.apply(response.setHeader, response, [name, [...values, value]])
}

const privateHeaders: ReadonlyArray<readonly [string, string]> = [
  ["cache-control", "private, no-store"],
  ["x-robots-tag", "noindex, nofollow"],
]

function markPrivate(event: ContentPreviewEvent): void {
  for (const [name, value] of privateHeaders) appendResponseHeader(event, name, value, "set")
}

function isResponseLike(value: unknown): value is Response {
  if (!isObject(value) || !isObject(value.headers)) return false
  const headers = value.headers
  // Use the Web Response shape instead of instanceof so responses from another
  // realm (or a host Web API implementation) are handled too.
  return headers.set instanceof Function && typeof value.status === "number" && "body" in value
}

function privateResponse<TResult>(result: TResult): TResult {
  if (!isResponseLike(result)) return result
  try {
    for (const [name, value] of privateHeaders) result.headers.set(name, value)
    return result
  }
  catch {
    // Immutable headers, such as a fetch() response: copy it.
    const copy = new Response(result.body, result)
    for (const [name, value] of privateHeaders) copy.headers.set(name, value)
    // SAFETY: The copy is a Response, the same type as the result it replaces.
    return copy as TResult
  }
}

function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return []
  const values: string[] = []
  for (const part of header.split(";")) {
    const separator = part.indexOf("=")
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    values.push(part.slice(separator + 1).trim())
  }
  return values
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0))
}

function decodeKey(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (/^[a-f0-9]{64}$/i.test(value)) return Uint8Array.from(value.match(/../g)!, byte => Number.parseInt(byte, 16))
  if (!/^[\w+/-]+={0,2}$/.test(value)) return
  try {
    return fromBase64url(value.replace(/=+$/, ""))
  }
  catch {
    return undefined
  }
}

function configuredKey(): string | undefined {
  const fromProcess: unknown = globalThis.process?.env?.[contentKeyVariable]
  const fromCloudflare: unknown = (globalThis as { __env__?: Record<string, unknown> }).__env__?.[contentKeyVariable]
  const value = String(fromProcess) === fromProcess && fromProcess ? fromProcess : String(fromCloudflare) === fromCloudflare ? fromCloudflare : undefined
  return value?.trim() || undefined
}

function developmentRuntime(): boolean {
  const mode = globalThis.process?.env?.NODE_ENV
  return mode === "development" || mode === "test"
}

const missingKeyMessage = `[vitehub] Content preview needs ${contentKeyVariable} with 32 random bytes as base64 or hex. Create one with \`openssl rand -base64 32\`.`
const importedKeys = new Map<string, Promise<HmacKey>>()
let developmentKey: Uint8Array<ArrayBuffer> | undefined
let warnedDevelopmentKey = false
let warnedInvalidKey = false

function importKey(id: string, bytes: Uint8Array<ArrayBuffer>): Promise<HmacKey> {
  let key = importedKeys.get(id)
  if (!key) {
    key = globalThis.crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
    importedKeys.set(id, key)
  }
  return key
}

/**
 * The HMAC key from `VITEHUB_CONTENT_KEY`. In development and tests without one, a random key for this process,
 * so tokens stop working after a restart. Otherwise `undefined`: preview is off and `enable()` throws.
 */
async function signingKey(): Promise<HmacKey | undefined> {
  const value = configuredKey()
  if (value !== undefined) {
    const bytes = decodeKey(value)
    if (bytes?.byteLength !== 32) throw contentErrorDiagnostics.CONTENT_R0010({ message: missingKeyMessage })
    return await importKey(value, bytes)
  }
  if (!developmentRuntime()) return
  if (!developmentKey) developmentKey = globalThis.crypto.getRandomValues(new Uint8Array(32))
  if (!warnedDevelopmentKey && globalThis.process?.env?.NODE_ENV === "development") {
    warnedDevelopmentKey = true
    console.warn(`[vitehub] ${contentKeyVariable} is not set. Content preview uses a random key until the server restarts. Production needs the variable.`)
  }
  return await importKey("development", developmentKey)
}

function tokenMessage(expires: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${tokenPurpose}.${tokenVersion}.${expires}`)
}

/** Return the expiry in seconds of a valid, unexpired token, or undefined. The HMAC check is constant-time. */
async function verifyToken(key: HmacKey, token: string): Promise<number | undefined> {
  const match = tokenPattern.exec(token)
  if (!match) return
  const expires = Number(match[1])
  const signature = fromBase64url(match[2]!)
  if (signature.byteLength !== 32) return
  if (!await globalThis.crypto.subtle.verify("HMAC", key, signature, tokenMessage(expires))) return
  const now = Date.now()
  if (expires * 1000 <= now || expires * 1000 > now + (maximumMaxAge + 60) * 1000) return
  return expires
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return `${contentPreviewCookieName}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`
}

function assertEvent(event: unknown, method: string): asserts event is ContentPreviewEvent {
  if (!isObject(event)) {
    throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] content.preview.${method}() requires an H3 event or a Request.` })
  }
}

interface Scope<T> { getStore(): T | undefined; run<R>(value: T, callback: () => R): R | Promise<R> }
function createScope<T>(enabled: boolean): Scope<T> {
  if (!enabled) return { getStore: () => undefined, run: (_value, callback) => callback() }
  const runtimeGlobal = globalThis as {
    AsyncLocalStorage?: new <V>() => Scope<V>
    process?: { getBuiltinModule?: (name: string) => { AsyncLocalStorage?: new <V>() => Scope<V> } | undefined }
  }
  const Constructor = runtimeGlobal.AsyncLocalStorage
    ?? runtimeGlobal.process?.getBuiltinModule?.("node:async_hooks")?.AsyncLocalStorage
  if (Constructor) return new Constructor<T>()
  // Preview state must survive Promise continuations and remain isolated between
  // concurrent requests. There is no safe synchronous fallback for that contract.
  // Fail while the Content runtime is created so unsupported hosts are detected at
  // startup/build time, instead of turning the first preview request into a 500.
  throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] Content preview needs an async request context (AsyncLocalStorage). On Cloudflare Workers, enable the nodejs_als compatibility flag." })
}

/** Create the preview grant and request scope for one Content runtime. */
export function createContentPreview(options: { enabled: boolean }): ContentPreview {
  // Proof that one request carried a valid token. Only this runtime issues and checks it.
  const previewGrant = defineGrant("vitehub.content.preview", (expires: number) => expires)
  const scope = createScope<ReturnType<typeof previewGrant.issue>>(options.enabled)
  const resolved = new WeakMap<object, Promise<ReturnType<typeof previewGrant.issue> | undefined>>()

  function requireEnabled(method: string): void {
    if (!options.enabled) {
      throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] content.preview.${method}() needs document collections. Add defineContent({ workspace, collections }).` })
    }
  }

  async function grantFor(event: ContentPreviewEvent): Promise<ReturnType<typeof previewGrant.issue> | undefined> {
    const tokens = cookieValues(requestHeader(event, "cookie"), contentPreviewCookieName)
    if (!tokens.length) return
    let key: HmacKey | undefined
    try {
      key = await signingKey()
    }
    catch (error) {
      if (!warnedInvalidKey) {
        warnedInvalidKey = true
        console.warn(error instanceof Error ? error.message : String(error))
      }
      return
    }
    if (!key) return
    for (const token of tokens) {
      const expires = await verifyToken(key, token)
      if (expires !== undefined) return previewGrant.issue(expires)
    }
  }

  return {
    async enable(event, enableOptions = {}) {
      requireEnabled("enable")
      assertEvent(event, "enable")
      const maxAge = enableOptions.maxAge ?? defaultMaxAge
      if (!Number.isSafeInteger(maxAge) || maxAge < minimumMaxAge || maxAge > maximumMaxAge) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] content.preview.enable({ maxAge }) must be whole seconds from ${minimumMaxAge} to ${maximumMaxAge}.` })
      }
      const key = await signingKey()
      if (!key) throw contentErrorDiagnostics.CONTENT_R0010({ message: missingKeyMessage })
      const expires = Math.floor(Date.now() / 1000) + maxAge
      const signature = await globalThis.crypto.subtle.sign("HMAC", key, tokenMessage(expires))
      const setCookie = cookie(`${tokenVersion}.${expires}.${base64url(signature)}`, maxAge, secureRequest(event))
      appendResponseHeader(event, "set-cookie", setCookie, "append")
      appendResponseHeader(event, "cache-control", "private, no-store", "set")
      return { setCookie, expiresAt: new Date(expires * 1000) }
    },
    disable(event) {
      assertEvent(event, "disable")
      const setCookie = cookie("", 0, secureRequest(event))
      appendResponseHeader(event, "set-cookie", setCookie, "append")
      appendResponseHeader(event, "cache-control", "private, no-store", "set")
      return { setCookie, expiresAt: null }
    },
    async run(event, callback) {
      if (!options.enabled || !isObject(event)) return await callback()
      // A nested run in the same request, such as /api/content inside the generated plugin's scope, keeps its grant.
      const current = scope.getStore()
      let grant = previewGrant.check(current) === undefined ? undefined : current
      if (!grant) {
        let pending = resolved.get(event)
        if (!pending) {
          pending = grantFor(event)
          resolved.set(event, pending)
        }
        grant = await pending
      }
      if (!grant) return await callback()
      markPrivate(event)
      const result = await scope.run(grant, callback)
      // Set again after the handler so route headers cannot make a draft response public.
      markPrivate(event)
      return privateResponse(result)
    },
    active() {
      return previewGrant.check(scope.getStore()) !== undefined
    },
  }
}

/** The part of a Content runtime the preview plugin needs. A runtime without `preview` leaves requests unchanged. */
export interface ContentPreviewHost {
  preview?: ContentPreview
}

function hasPreviewCookie(event: ContentPreviewEvent): boolean {
  return cookieValues(requestHeader(event, "cookie"), contentPreviewCookieName).length > 0
}

/**
 * A Nitro plugin that scopes each request carrying the preview cookie to the draft ref, on Nitro 3 and on Nitro 2
 * (Nuxt 4). It wraps Nitro's request entry, so the scope covers route rules, middleware, cached routes, and every
 * handler. During a preview request Nitro's cache is bypassed: cached handlers, `cache`/`swr` route rules, and
 * cached functions neither read nor write an entry. Requests without the cookie pass straight through.
 * ViteHub generates this plugin for `server/content.ts`.
 */
export function defineContentPreviewPlugin(content: ContentPreviewHost): (nitroApp: unknown) => void {
  return (nitroApp) => {
    const preview = content.preview
    if (!preview || !isObject(nitroApp)) return
    // ViteHub routes Nitro's cache module through this check (nitroCacheBypass); the grant scope is the request's.
    const removeCacheBypass = addCacheBypass(() => preview.active())
    const hooks = nitroApp.hooks
    if (isObject(hooks) && hooks.hook instanceof Function) {
      const dispose = () => removeCacheBypass()
      for (const name of ["close", "shutdown", "dispose"]) {
        Reflect.apply(hooks.hook, hooks, [name, dispose])
      }
    }
    const scoped = (event: unknown, next: () => unknown): unknown =>
      isObject(event) && hasPreviewCookie(event) ? preview.run(event, next) : next()
    // Nitro 3: the Web fetch entry every preset and internal fetch calls.
    if (nitroApp.fetch instanceof Function) {
      const fetch = nitroApp.fetch
      nitroApp.fetch = (request: unknown, ...rest: unknown[]) => scoped(request, () => Reflect.apply(fetch, nitroApp, [request, ...rest]))
      return
    }
    // Nitro 2: the h3 v1 app handler. h3 v1 middleware cannot wrap the rest of a request, and the app handler can.
    const h3App = nitroApp.h3App
    if (isObject(h3App) && h3App.handler instanceof Function) {
      const handler = h3App.handler
      h3App.handler = (event: unknown) => scoped(event, () => Reflect.apply(handler, h3App, [event]))
      // Route rule headers run inside the request, so mark the response private again just before it is sent.
      const hooks = nitroApp.hooks
      if (isObject(hooks) && hooks.hook instanceof Function) {
        Reflect.apply(hooks.hook, hooks, ["beforeResponse", (event: ContentPreviewEvent) => {
          if (preview.active()) markPrivate(event)
        }])
      }
      return
    }
    throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] defineContentPreviewPlugin() needs a Nitro 2 or Nitro 3 app." })
  }
}
