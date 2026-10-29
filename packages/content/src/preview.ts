import { addCacheBypass } from "@vite-hub/internal/runtime/cache-bypass"
import { defineGrant } from "@vite-hub/runtime/internal/grant"

import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { contentPreviewFrameParameter, contentPreviewPublishedParameter } from "./preview-parameters.ts"

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
// A frame token signs one document with its own purpose and shape, so it never passes as a cookie token or the reverse.
const frameTokenVersion = "f1"
const frameTokenPurpose = "vitehub.content.preview.frame"
const frameTokenPattern = /^f1\.(\d{1,12})\.([\w-]{1,1400})\.([\w-]{43})$/

export { contentPreviewFrameParameter, contentPreviewPublishedParameter } from "./preview-parameters.ts"
/** The largest preview frame form, in bytes. It carries a whole Markdown document. */
const maximumFrameBytes = 1024 * 1024

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

/** The one document that a preview frame token lets a page read as a draft. */
export interface ContentPreviewFrameOptions extends ContentPreviewOptions {
  collection: string
  id: string
}

/** A document that a preview frame shows in place of its stored draft, such as edits that were not saved yet. */
export interface ContentPreviewDocument {
  collection: string
  id: string
  data: Record<string, unknown>
  /** The Markdown body. JSON and YAML documents have none. */
  body?: string
}

/**
 * The current preview frame request: the document its token signs, and the version on screen that the frame posted
 * for it, if any.
 */
export interface ContentPreviewFrame {
  collection: string
  id: string
  document?: ContentPreviewDocument
}

export interface ContentPreviewToken {
  /** The signed token. A preview frame form sends it; keep it out of URLs. */
  token: string
  expiresAt: Date
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
 * A preview frame request reads the draft of one document only; see {@link ContentPreview.sign}.
 */
export interface ContentPreview {
  /**
   * Sign a preview token and set it as an `HttpOnly`, `SameSite=Strict` cookie on the event response. This is trusted
   * server API: check `content.can({ user, collection, action: "read" })` before calling it. The token previews every
   * collection of this runtime until it expires. A preview frame token from `sign()` never sets or acts as this cookie.
   */
  enable(event: ContentPreviewEvent, options?: ContentPreviewOptions): Promise<ContentPreviewCookie>
  /** Clear the preview cookie. Later requests read `published` again. */
  disable(event: ContentPreviewEvent): ContentPreviewCookie
  /**
   * Run `callback` with the event's preview grant when its cookie holds a valid token, and mark the response
   * `Cache-Control: private, no-store`. Without a valid token `callback` runs unchanged. An event whose URL, or
   * same-origin `Referer`, has `?vitehub-content-published` reads `published` with or without the cookie. A run inside
   * another run of the same request keeps the outer scope: a cookie never widens a published or frame request. In a
   * ViteHub app the generated Nitro plugin and `/api/content/**` call it for you; call it yourself for requests that do
   * not go through Nitro.
   */
  run<TResult>(event: ContentPreviewEvent, callback: () => TResult | Promise<TResult>): Promise<TResult>
  /**
   * Sign a preview frame token for one document, without a cookie. This is trusted server API: check
   * `content.can({ user, collection, id, action: "read" })` before calling it. In a frame request with this token,
   * collection `get()` and `list()` without `ref` or `revision` read the draft of that document only, or the version
   * the frame posted for it. Every other read is published. See {@link defineContentPreviewPlugin}.
   */
  sign(options: ContentPreviewFrameOptions): Promise<ContentPreviewToken>
  /**
   * Whether Content reads in the current request use the `draft` ref: true with a preview cookie, false in a frame and
   * in a request with `?vitehub-content-published`.
   */
  active(): boolean
  /** The current preview frame request, or undefined outside one. */
  frame(): ContentPreviewFrame | undefined
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

function frameTokenMessage(expires: number, scope: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${frameTokenPurpose}.${frameTokenVersion}.${expires}.${scope}`)
}

function encodeScope(collection: string, id: string): string {
  return base64url(new TextEncoder().encode(JSON.stringify([collection, id])).buffer)
}

function decodeScope(value: string): { collection: string, id: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(value)))
    if (!Array.isArray(parsed) || parsed.length !== 2) return
    const [collection, id] = parsed
    return String(collection) === collection && collection && String(id) === id && id ? { collection, id } : undefined
  }
  catch {
    return undefined
  }
}

function unexpired(expires: number): boolean {
  const now = Date.now()
  return expires * 1000 > now && expires * 1000 <= now + (maximumMaxAge + 60) * 1000
}

/** Return the expiry in seconds of a valid, unexpired token, or undefined. The HMAC check is constant-time. */
async function verifyToken(key: HmacKey, token: string): Promise<number | undefined> {
  const match = tokenPattern.exec(token)
  if (!match) return
  const expires = Number(match[1])
  const signature = fromBase64url(match[2]!)
  if (signature.byteLength !== 32) return
  if (!await globalThis.crypto.subtle.verify("HMAC", key, signature, tokenMessage(expires))) return
  return unexpired(expires) ? expires : undefined
}

/** Return the expiry and document of a valid, unexpired frame token, or undefined. The HMAC check is constant-time. */
async function verifyFrameToken(key: HmacKey, token: string): Promise<{ expires: number, collection: string, id: string } | undefined> {
  const match = frameTokenPattern.exec(token)
  if (!match) return
  const expires = Number(match[1])
  const signature = fromBase64url(match[3]!)
  if (signature.byteLength !== 32) return
  if (!await globalThis.crypto.subtle.verify("HMAC", key, signature, frameTokenMessage(expires, match[2]!))) return
  const scope = decodeScope(match[2]!)
  return scope && unexpired(expires) ? { expires, ...scope } : undefined
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
  type Grant = ReturnType<typeof previewGrant.issue>
  /**
   * A cookie grant reads every draft. A frame grant reads the draft of its one document. A published request has no
   * grant, and a cookie in a nested run cannot give it one.
   */
  type State = { grant: Grant, frame?: ContentPreviewFrame } | { published: true }
  const scope = createScope<State>(options.enabled)
  const resolved = new WeakMap<object, Promise<Grant | undefined>>()

  function current(): { grant: Grant, frame?: ContentPreviewFrame } | undefined {
    const state = scope.getStore()
    return state && "grant" in state && previewGrant.check(state.grant) !== undefined ? state : undefined
  }

  async function sign(signOptions: ContentPreviewOptions, method: string, scope?: string): Promise<{ maxAge: number, expires: number, token: string }> {
    requireEnabled(method)
    const maxAge = signOptions.maxAge ?? defaultMaxAge
    if (!Number.isSafeInteger(maxAge) || maxAge < minimumMaxAge || maxAge > maximumMaxAge) {
      throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] content.preview.${method}({ maxAge }) must be whole seconds from ${minimumMaxAge} to ${maximumMaxAge}.` })
    }
    const key = await signingKey()
    if (!key) throw contentErrorDiagnostics.CONTENT_R0010({ message: missingKeyMessage })
    const expires = Math.floor(Date.now() / 1000) + maxAge
    if (scope === undefined) {
      const signature = await globalThis.crypto.subtle.sign("HMAC", key, tokenMessage(expires))
      return { maxAge, expires, token: `${tokenVersion}.${expires}.${base64url(signature)}` }
    }
    const signature = await globalThis.crypto.subtle.sign("HMAC", key, frameTokenMessage(expires, scope))
    return { maxAge, expires, token: `${frameTokenVersion}.${expires}.${scope}.${base64url(signature)}` }
  }

  async function frameForToken(token: string): Promise<{ grant: Grant, collection: string, id: string } | undefined> {
    let key: HmacKey | undefined
    try {
      key = await signingKey()
    }
    catch {
      return
    }
    if (!key) return
    const verified = await verifyFrameToken(key, token)
    return verified && { grant: previewGrant.issue(verified.expires), collection: verified.collection, id: verified.id }
  }

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

  const preview: ContentPreview = {
    async enable(event, enableOptions = {}) {
      requireEnabled("enable")
      assertEvent(event, "enable")
      const { maxAge, expires, token } = await sign(enableOptions, "enable")
      const setCookie = cookie(token, maxAge, secureRequest(event))
      appendResponseHeader(event, "set-cookie", setCookie, "append")
      appendResponseHeader(event, "cache-control", "private, no-store", "set")
      return { setCookie, expiresAt: new Date(expires * 1000) }
    },
    async sign(signOptions) {
      const { collection, id } = isObject(signOptions) ? signOptions : {}
      if (String(collection) !== collection || !collection || String(id) !== id || !id) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] content.preview.sign() requires { collection, id }: the one document the frame previews." })
      }
      const scope = encodeScope(collection, id)
      if (!frameTokenPattern.test(`${frameTokenVersion}.0.${scope}.${"A".repeat(43)}`)) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] content.preview.sign() received a collection and id that are too long." })
      }
      const { expires, token } = await sign(signOptions, "sign", scope)
      return { token, expiresAt: new Date(expires * 1000) }
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
      // A nested run in the same request, such as /api/content inside the generated plugin's scope, keeps its grant
      // and the documents of a preview frame, or its published reads.
      let state: State | undefined = scope.getStore()
      if (state && "grant" in state && previewGrant.check(state.grant) === undefined) state = undefined
      if (!state && publishedRequest(event)) state = { published: true }
      if (!state) {
        let pending = resolved.get(event)
        if (!pending) {
          pending = grantFor(event)
          resolved.set(event, pending)
        }
        const grant = await pending
        if (grant) state = { grant }
      }
      if (!state) return await callback()
      markPrivate(event)
      const result = await scope.run(state, callback)
      // Set again after the handler so route headers cannot make a draft response public.
      markPrivate(event)
      return privateResponse(result)
    },
    active() {
      const state = current()
      return state !== undefined && state.frame === undefined
    },
    frame() {
      return current()?.frame
    },
  }
  frames.set(preview, {
    published() {
      const state = scope.getStore()
      return state !== undefined && "published" in state
    },
    async run(form, callback) {
      if (!options.enabled) return
      const verified = await frameForToken(form.token)
      if (!verified) return
      const { grant, collection, id } = verified
      // The token signs one document: a form that posts any other document is refused, not partly applied.
      if (form.document && (form.document.collection !== collection || form.document.id !== id)) return
      const frame: ContentPreviewFrame = form.document ? { collection, id, document: form.document } : { collection, id }
      return { result: await scope.run({ grant, frame }, callback) }
    },
  })
  return preview
}

interface ContentPreviewFrameForm {
  token: string
  document?: ContentPreviewDocument
}

interface ContentPreviewFrames {
  /** Whether the current request reads `published` only. */
  published(): boolean
  /** Runs a preview frame request with the grant of its token. Undefined when the token is not valid. */
  run<TResult>(form: ContentPreviewFrameForm, callback: () => TResult | Promise<TResult>): Promise<{ result: Awaited<TResult> } | undefined>
}

const frames = new WeakMap<ContentPreview, ContentPreviewFrames>()

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Reads the form a preview frame posts. Undefined for anything else. */
export function parseContentPreviewFrameForm(text: string): ContentPreviewFrameForm | undefined {
  const value = new URLSearchParams(text).get(contentPreviewFrameParameter)
  if (value === null) return
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  }
  catch {
    return
  }
  if (!isPlainRecord(parsed) || String(parsed.token) !== parsed.token) return
  const document = parsed.document
  if (document === undefined) return { token: parsed.token }
  if (!isPlainRecord(document) || !isPlainRecord(document.data)) return
  const { collection, id, body } = document
  if (String(collection) !== collection || !collection || String(id) !== id || !id) return
  if (body !== undefined && String(body) !== body) return
  return { token: parsed.token, document: body === undefined ? { collection, id, data: document.data } : { collection, id, data: document.data, body } }
}

function forbidden(message: string): Response {
  return new Response(message, { status: 403, headers: { "cache-control": "private, no-store", "content-type": "text/plain; charset=utf-8" } })
}

/**
 * A request that may come from another site cannot use a preview frame. Browsers send `Sec-Fetch-Site` and `Origin`
 * with a form POST; a request without them, such as from a server, still needs a valid token.
 */
function crossSite(headers: unknown, url: URL): boolean {
  const site = readHeader(headers, "sec-fetch-site")
  if (site !== undefined && site !== "same-origin") return true
  const origin = readHeader(headers, "origin")
  return origin !== undefined && origin !== "null" && origin !== url.origin
}

/**
 * The public URL of a frame request. A Node request URL is a path, so the origin comes from the Host header and the
 * protocol from `secureRequest()`: `X-Forwarded-Proto` from a proxy, else the TLS socket. A cross-site form cannot set
 * these headers, so `crossSite()` still refuses it. The `Origin` header is never used to build this URL.
 */
function frameUrl(value: unknown, headers: unknown, secure: boolean): URL | undefined {
  if (String(value) !== value) return
  try {
    return new URL(value, `${secure ? "https" : "http"}://${readHeader(headers, "host") ?? "localhost"}`)
  }
  catch {
    return undefined
  }
}

/**
 * Whether a request asks for published reads: its URL has `?vitehub-content-published`, or its `Referer` is a page of
 * the same origin with it, such as a fetch from the page in the Published view. It only takes draft access away.
 */
function publishedRequest(event: ContentPreviewEvent): boolean {
  const url = requestUrl(event)
  if (!url) return false
  if (url.searchParams.has(contentPreviewPublishedParameter)) return true
  const referer = requestHeader(event, "referer")
  if (!referer) return false
  try {
    const from = new URL(referer)
    return from.origin === url.origin && from.searchParams.has(contentPreviewPublishedParameter)
  }
  catch {
    return false
  }
}

function requestUrl(event: ContentPreviewEvent): URL | undefined {
  const parts = eventParts(event)
  // An h3 v2 event has a URL object; a Request and a Node request have text.
  return frameUrl(parts.url instanceof URL ? parts.url.href : parts.url, parts.headers, secureRequest(event))
}

/**
 * The `Location` of a redirect from a published request, with `?vitehub-content-published` added when the browser
 * sends the preview cookie to it: the same host name as the request, from its URL or `X-Forwarded-Host`. The browser
 * then follows the redirect with published reads too, and so does each later redirect. The rest of the URL stays as
 * it is. A `Location` to another host, or one that has the parameter, is not changed.
 */
function publishedLocation(location: string, event: ContentPreviewEvent): string {
  const url = requestUrl(event)
  if (!url) return location
  let target: URL
  try {
    target = new URL(location, url)
  }
  catch {
    return location
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return location
  if (target.searchParams.has(contentPreviewPublishedParameter)) return location
  const forwarded = requestHeader(event, "x-forwarded-host")?.split(",", 1)[0]?.trim()
  const proxied = forwarded && URL.canParse(`http://${forwarded}`) ? new URL(`http://${forwarded}`).hostname : undefined
  if (target.hostname !== url.hostname && target.hostname !== proxied) return location
  const hash = location.indexOf("#")
  const head = hash < 0 ? location : location.slice(0, hash)
  const separator = !head.includes("?") ? "?" : /[?&]$/.test(head) ? "" : "&"
  return `${head}${separator}${contentPreviewPublishedParameter}${hash < 0 ? "" : location.slice(hash)}`
}

function isRedirect(status: unknown): boolean {
  return typeof status === "number" && status >= 300 && status < 400
}

/** A Web redirect response of a published request, with its `Location` marked by `publishedLocation()`. */
function publishedRedirect<TResult>(result: TResult, event: ContentPreviewEvent): TResult {
  if (!isResponseLike(result) || !isRedirect(result.status)) return result
  const location = result.headers.get("location")
  if (location === null) return result
  const marked = publishedLocation(location, event)
  if (marked === location) return result
  try {
    result.headers.set("location", marked)
    return result
  }
  catch {
    const copy = new Response(result.body, result)
    copy.headers.set("location", marked)
    // SAFETY: The copy is a Response, the same type as the result it replaces.
    return copy as TResult
  }
}

/**
 * Marks the `Location` of a Node redirect of a published request as `publishedLocation()` does. Node writes the head
 * of every response with `writeHead()`, also when h3 v1 calls `end()`, so this request's response marks it there.
 */
function markNodeRedirects(event: ContentPreviewEvent): void {
  const response = eventParts(event).node
  const writeHead = response?.writeHead
  if (!response || !(writeHead instanceof Function)) return
  response.writeHead = function (this: unknown, status: unknown, ...rest: unknown[]) {
    if (isRedirect(status)) {
      const headers = rest.find(isPlainRecord)
      const name = headers && Object.keys(headers).find(name => name.toLowerCase() === "location")
      if (headers && name && String(headers[name]) === headers[name]) headers[name] = publishedLocation(headers[name], event)
      // Node also takes the headers as one flat list of names and values, which `getHeader()` cannot read back.
      const raw = rest.find(Array.isArray)
      for (let index = 0; raw && index < raw.length - 1; index += 2) {
        const value: unknown = raw[index + 1]
        if (String(raw[index]).toLowerCase() === "location" && String(value) === value) raw[index + 1] = publishedLocation(value, event)
      }
      const location: unknown = response.getHeader instanceof Function ? Reflect.apply(response.getHeader, response, ["location"]) : undefined
      if (String(location) === location && response.setHeader instanceof Function) {
        Reflect.apply(response.setHeader, response, ["location", publishedLocation(location, event)])
      }
    }
    return Reflect.apply(writeHead, this, [status, ...rest])
  }
}

function isFrameRequest(method: unknown, url: URL | undefined): url is URL {
  return String(method).toUpperCase() === "POST" && url !== undefined && url.searchParams.has(contentPreviewFrameParameter)
}

/**
 * Reads a frame form body of at most `maximumFrameBytes`, counting the bytes as they arrive. A declared length is not
 * trusted: reading stops at the first chunk over the limit and cancels the rest. A larger or broken body is undefined.
 */
async function readNodeBody(request: AsyncIterable<unknown>): Promise<string | undefined> {
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    // Leaving the loop early destroys the Node stream, so no more of the body is read.
    for await (const chunk of request) {
      const bytes = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk))
      size += bytes.byteLength
      if (size > maximumFrameBytes) return
      chunks.push(bytes)
    }
  }
  catch {
    return
  }
  return decodeChunks(chunks, size)
}

async function readRequestBody(request: Request): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > maximumFrameBytes) {
    discardRequestBody(request)
    return
  }
  if (!request.body) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    const reader = request.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumFrameBytes) {
        reader.cancel().catch(() => undefined)
        return
      }
      chunks.push(value)
    }
  }
  catch {
    return
  }
  return decodeChunks(chunks, size)
}

/** Cancels a request body that is not read, such as a frame form from another site. */
function discardRequestBody(request: Request): void {
  if (request.body && !request.body.locked) request.body.cancel().catch(() => undefined)
}

function decodeChunks(chunks: Uint8Array[], size: number): string {
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

/** How many same-origin redirects a preview frame follows in the server before it returns the redirect. */
const maximumFrameRedirects = 5

/**
 * Runs a preview frame page and follows its same-origin redirects inside the frame scope, such as a locale or canonical
 * redirect. The browser would follow them without the form, and so without the token and the document on screen. The
 * frame shows the last page at the URL it posted to. A redirect to another origin, one that sets a cookie, or one past
 * the limit is returned.
 */
async function followFrameRedirects(first: Request, page: (url: URL) => Request, render: (request: Request) => unknown): Promise<unknown> {
  let request = first
  for (let hop = 0; ; hop++) {
    const result = await render(request)
    if (!isResponseLike(result) || !isRedirect(result.status) || hop === maximumFrameRedirects) return result
    // A redirect that sets a cookie goes to the browser, which applies the cookie the way the next request expects.
    if (result.headers.getSetCookie().length) return result
    const location = result.headers.get("location")
    if (location === null || !URL.canParse(location, request.url)) return result
    const target = new URL(location, request.url)
    if (target.origin !== new URL(first.url).origin) return result
    result.body?.cancel().catch(() => undefined)
    // A server never sees the fragment: the browser keeps it.
    target.hash = ""
    target.searchParams.delete(contentPreviewFrameParameter)
    request = page(target)
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
 *
 * It also serves preview frames, such as the side browser of the Console. A frame posts a form to the page URL with
 * `?vitehub-content-preview`, and the form field of the same name holds `{ token, document? }` as JSON: a token from
 * `content.preview.sign({ collection, id })` and, optionally, the version of that document to show in place of its
 * stored draft. The page runs as a GET request without the parameter. Collection `get()` and `list()` without `ref` or
 * `revision` read that one document as a draft; every other read is published. Nothing is stored, and the response is
 * `private, no-store`. A form from another site, without a valid frame token, or with a document that the token does
 * not sign gets 403. A preview cookie token is not a frame token, and a frame token is not a cookie token.
 *
 * A request with `?vitehub-content-published` in its URL, or in its same-origin `Referer`, reads `published` even with a
 * preview cookie, such as the Published view of the Console. Its nested runs do too. The page sees its URL with the
 * parameter, the cookie stays as it is, the response is `private, no-store`, and Nitro's cache is bypassed. A redirect
 * from it to the same host name, such as a canonical or locale redirect, gets the parameter in its `Location`, so the
 * page the browser lands on reads `published` too. A redirect to another host is not changed.
 * ViteHub generates this plugin for `server/content.ts`.
 */
export function defineContentPreviewPlugin(content: ContentPreviewHost): (nitroApp: unknown) => void {
  return (nitroApp) => {
    const preview = content.preview
    if (!preview || !isObject(nitroApp)) return
    const frame = frames.get(preview)
    // ViteHub routes Nitro's cache module through this check (nitroCacheBypass); the grant scope is the request's.
    const previewing = () => preview.active() || preview.frame() !== undefined || frame?.published() === true
    const removeCacheBypass = addCacheBypass(previewing)
    const hooks = nitroApp.hooks
    if (isObject(hooks) && hooks.hook instanceof Function) {
      const dispose = () => removeCacheBypass()
      for (const name of ["close", "shutdown", "dispose"]) {
        Reflect.apply(hooks.hook, hooks, [name, dispose])
      }
    }
    const scoped = (event: unknown, next: () => unknown): unknown => {
      if (!isObject(event)) return next()
      if (!publishedRequest(event)) return hasPreviewCookie(event) ? preview.run(event, next) : next()
      // A redirect keeps the request published: the browser follows it with the cookie, but without this URL.
      markNodeRedirects(event)
      return preview.run(event, next).then(result => publishedRedirect(result, event))
    }
    /** Checks a preview frame form and runs the page with its grant, or returns the 403 response. */
    async function runFrame(blocked: boolean, body: string | undefined, next: () => unknown): Promise<unknown> {
      if (blocked) return forbidden("A preview frame must come from this site.")
      const form = body === undefined ? undefined : parseContentPreviewFrameForm(body)
      const ran = form && frame ? await frame.run(form, next) : undefined
      return ran ? privateResponse(ran.result) : forbidden("The preview expired. Open the preview again.")
    }
    // Nitro 3: the Web fetch entry every preset and internal fetch calls.
    if (nitroApp.fetch instanceof Function) {
      const fetch = nitroApp.fetch
      nitroApp.fetch = (request: unknown, ...rest: unknown[]) => {
        const url = request instanceof Request ? frameUrl(request.url, request.headers, secureRequest(request)) : undefined
        if (!(request instanceof Request) || !isFrameRequest(request.method, url)) {
          return scoped(request, () => Reflect.apply(fetch, nitroApp, [request, ...rest]))
        }
        return (async () => {
          // A form from another site is refused before its body is read.
          const blocked = crossSite(request.headers, url)
          if (blocked) discardRequestBody(request)
          const body = blocked ? undefined : await readRequestBody(request)
          url.searchParams.delete(contentPreviewFrameParameter)
          const headers = new Headers(request.headers)
          headers.delete("content-type")
          headers.delete("content-length")
          const page = (target: URL) => new Request(target, { method: "GET", headers, signal: request.signal })
          return await runFrame(blocked, body, () => followFrameRedirects(page(url), page, next => scoped(next, () => Reflect.apply(fetch, nitroApp, [next, ...rest]))))
        })()
      }
      return
    }
    // Nitro 2: the h3 v1 app handler. h3 v1 middleware cannot wrap the rest of a request, and the app handler can.
    const h3App = nitroApp.h3App
    if (isObject(h3App) && h3App.handler instanceof Function) {
      const handler = h3App.handler
      h3App.handler = (event: unknown) => {
        const node = isObject(event) && isObject(event.node) ? event.node : undefined
        const request = isObject(node?.req) ? node.req : undefined
        const url = isObject(event) ? frameUrl(request?.url, request?.headers, secureRequest(event)) : undefined
        if (!event || !request || !isFrameRequest(request.method, url) || !(Symbol.asyncIterator in request)) {
          return scoped(event, () => Reflect.apply(handler, h3App, [event]))
        }
        return (async () => {
          const headers = isObject(request.headers) ? request.headers : {}
          // A form from another site is refused before its body is read.
          const blocked = crossSite(headers, url)
          // SAFETY: A Node IncomingMessage is an async iterable of its body chunks, checked above.
          const body = blocked ? undefined : await readNodeBody(request as unknown as AsyncIterable<unknown>)
          // The page sees a GET request for its own URL. h3 v1 caches the method, path, and headers on the event.
          url.searchParams.delete(contentPreviewFrameParameter)
          request.method = "GET"
          request.url = `${url.pathname}${url.search}`
          delete headers["content-type"]
          delete headers["content-length"]
          for (const cached of ["_method", "_path", "_headers"]) {
            if (Reflect.has(Object(event), cached)) Reflect.set(Object(event), cached, undefined)
          }
          const result = await runFrame(blocked, body, () => scoped(event, () => Reflect.apply(handler, h3App, [event])))
          if (!(result instanceof Response) || result.status !== 403 || !isObject(node?.res)) return result
          const response = node.res
          if (response.headersSent === true || !(response.end instanceof Function) || !(response.setHeader instanceof Function)) return result
          response.statusCode = 403
          for (const [name, value] of result.headers) Reflect.apply(response.setHeader, response, [name, value])
          // The body of a form from another site is never read. Close the connection after the 403 instead of draining
          // an upload that may be slow or large.
          if (blocked) Reflect.apply(response.setHeader, response, ["connection", "close"])
          const closeUnread = () => {
            if (blocked && request.destroy instanceof Function) Reflect.apply(request.destroy, request, [])
          }
          Reflect.apply(response.end, response, [await result.text(), closeUnread])
        })()
      }
      // Route rule headers run inside the request, so mark the response private again just before it is sent.
      const hooks = nitroApp.hooks
      if (isObject(hooks) && hooks.hook instanceof Function) {
        Reflect.apply(hooks.hook, hooks, ["beforeResponse", (event: ContentPreviewEvent) => {
          if (previewing()) markPrivate(event)
        }])
      }
      return
    }
    throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] defineContentPreviewPlugin() needs a Nitro 2 or Nitro 3 app." })
  }
}
