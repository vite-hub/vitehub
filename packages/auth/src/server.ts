import discoveredDefinition from "#vitehub/auth/definition"
import { betterAuth } from "better-auth"
import { resolveAuthMountPath } from "./application-path.ts"
import { normalizeAuthBasePath } from "./shared.ts"
import { unwrapAuthRequest } from "./request.ts"
import { resolveAuthOptions } from "./runtime-options.ts"
import { throwAuthenticationProviderError } from "./errors.ts"
import { getAuthenticationSession } from "./session.ts"
import { getAuthRuntimeState } from "./runtime-state.ts"

import type { AccessAuthorizeOption, PublicUrlConfig } from "@vite-hub/runtime"
import type {
  AuthAccessAuthorize,
  AuthAccessConfiguration,
  AuthAccessAuthorizationContext,
  AuthAccessRoute,
  AuthAuthorization,
  AuthBetterAuthRuntimeOptions,
  AuthDefinition,
  AuthGuardedHandler,
  AuthRequest,
  AuthRequestInput,
  AuthRuntimeOptions,
  AuthSignInConfiguration,
  ResolvedAuthAccessRoute,
  ViteHubAuth,
} from "./types.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"

// Capture the intrinsic typed-array brand getter before mutable prototype state
// can be changed by application code. The getter itself performs the internal
// brand check and remains valid for values from other JavaScript realms.
// Resolve the shared %TypedArray%.prototype through a sibling typed-array
// constructor. This avoids depending on a potentially replaced
// Uint8Array.prototype chain during module initialization.
const intrinsicTypedArrayTagGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Int8Array.prototype),
  Symbol.toStringTag,
)?.get

// Keep Promise adoption independent from mutable instance methods. Calling this
// intrinsic also works for native Promise objects created in another realm.
const intrinsicPromiseThen = Promise.prototype.then

function isIntrinsicUint8Array(value: unknown): value is Uint8Array {
  if (!intrinsicTypedArrayTagGetter) return false
  try {
    return Reflect.apply(intrinsicTypedArrayTagGetter, value, []) === "Uint8Array"
  }
  catch {
    return false
  }
}

export { resetAuth } from "./runtime-state.ts"

declare const __VITEHUB_PUBLIC_URL__: PublicUrlConfig | undefined

type AuthRuntimeEnvResolver = (event?: unknown) => Record<string, unknown>

function hasRuntimeOptions(options: AuthRuntimeOptions | undefined): boolean {
  return Boolean(options && Object.keys(options).length > 0)
}

function hasRequestRuntimeOptions(definition: AuthDefinition): boolean {
  if (typeof definition.options === "function") return true
  return typeof definition.options.runtime === "function"
}

function hasConfiguredPublicUrl(): boolean {
  return typeof __VITEHUB_PUBLIC_URL__ !== "undefined"
    && Boolean(__VITEHUB_PUBLIC_URL__?.url || Object.keys(__VITEHUB_PUBLIC_URL__?.agents ?? {}).length)
}

function getAuthRuntimeEnvResolver(): AuthRuntimeEnvResolver | undefined {
  return getAuthRuntimeState().envResolver
}

export function setAuthRuntimeEnvResolver(resolver: AuthRuntimeEnvResolver | undefined): void {
  getAuthRuntimeState().envResolver = resolver
}

interface RequestInitWithDuplex extends RequestInit {
  duplex?: "half"
}

function toRequest(request: AuthRequest): Request {
  if (request instanceof Request) return request
  const init: RequestInitWithDuplex = {
    headers: request.headers,
    method: request.method,
    signal: request.signal,
  }
  if (request.body) {
    init.body = request.body
    init.duplex = "half"
  }
  return new Request(request.url, init)
}

export function createAuthRequestRuntimeOptions(
  definition: AuthDefinition,
  request: Pick<Request, "headers" | "url">,
  runtimeOptions: AuthRuntimeOptions = {},
  event?: unknown,
): AuthRuntimeOptions {
  return resolveAuthOptions(definition, { request, runtimeOptions, event, env: getAuthRuntimeEnvResolver() }).requestRuntimeOptions
}

function resolveDefaultDefinition(): AuthDefinition {
  if (!discoveredDefinition) {
    throw authErrorDiagnostics.AUTH_R0005({ message: "[vitehub] No Auth Definition was discovered. Add `server/auth.ts` or `server.auth.ts`." })
  }
  return discoveredDefinition
}

export function createBetterAuthOptions(
  definition: AuthDefinition,
  runtimeOptions: AuthRuntimeOptions = {},
): AuthBetterAuthRuntimeOptions {
  return resolveAuthOptions(definition, { runtimeOptions, env: getAuthRuntimeEnvResolver() }).providerOptions
}

function createAuthenticationProvider(options: AuthBetterAuthRuntimeOptions): ViteHubAuth {
  try {
    return betterAuth(options) as ViteHubAuth
  }
  catch (cause) {
    throwAuthenticationProviderError(cause, "get-auth-for-request")
  }
}

export function createAuth(
  definition: AuthDefinition,
  runtimeOptions?: AuthRuntimeOptions,
): ViteHubAuth {
  return betterAuth(createBetterAuthOptions(definition, runtimeOptions)) as ViteHubAuth
}

export function createAuthForRequest(
  definition: AuthDefinition,
  request: Pick<Request, "headers" | "url">,
  runtimeOptions?: AuthRuntimeOptions,
  event?: unknown,
): ViteHubAuth {
  return betterAuth(resolveAuthOptions(definition, { request, runtimeOptions, event, env: getAuthRuntimeEnvResolver() }).providerOptions) as ViteHubAuth
}

export function handleAuthRequest(
  definition: AuthDefinition,
  input: AuthRequestInput,
  runtimeOptions?: AuthRuntimeOptions,
  event: unknown = input,
): Promise<Response> {
  const request = unwrapAuthRequest(input)
  return createAuthForRequest(definition, request, runtimeOptions, event).handler(toRequest(request))
}

/** Return the request of a Web Request or a host server event, including an H3 1 event in Nuxt 4. */
export function toAuthRequest(input: AuthRequestInput): AuthRequest {
  return unwrapAuthRequest(input)
}

export function createAuthHandler(
  definition: AuthDefinition,
  runtimeOptions?: AuthRuntimeOptions,
): ViteHubAuth["handler"] {
  return createAuth(definition, runtimeOptions).handler
}

export function getAuthForDefinition(
  definition: AuthDefinition,
  runtimeOptions?: AuthRuntimeOptions,
): ViteHubAuth {
  if (hasRuntimeOptions(runtimeOptions)) {
    return createAuthenticationProvider(createBetterAuthOptions(definition, runtimeOptions))
  }

  const state = getAuthRuntimeState()
  if (!state.auth || state.definition !== definition) {
    state.auth = createAuthenticationProvider(createBetterAuthOptions(definition))
    state.definition = definition
  }
  return state.auth
}

export function getAuth(runtimeOptions?: AuthRuntimeOptions): ViteHubAuth {
  return getAuthForDefinition(resolveDefaultDefinition(), runtimeOptions)
}

export function getAuthForRequest(
  request: Pick<Request, "headers" | "url">,
  runtimeOptions?: AuthRuntimeOptions,
  event?: unknown,
): ViteHubAuth {
  const definition = resolveDefaultDefinition()
  if (!hasRequestRuntimeOptions(definition) && !hasRuntimeOptions(runtimeOptions) && !hasConfiguredPublicUrl()) {
    return getAuthForDefinition(definition)
  }
  return createAuthenticationProvider(resolveAuthOptions(definition, { request, runtimeOptions, event, env: getAuthRuntimeEnvResolver() }).providerOptions)
}

export async function assertAuthOrigin(
  request: Pick<Request, "headers" | "url">,
  event?: unknown,
): Promise<ViteHubAuth> {
  const origin = request.headers.get("origin")
  if (!origin) throw authErrorDiagnostics.AUTH_R0006({ message: "The request origin is required." })
  const auth = getAuthForRequest(request, undefined, event)
  if (!(await auth.$context).isTrustedOrigin(origin)) {
    throw authErrorDiagnostics.AUTH_R0007({ message: "The request origin is not trusted." })
  }
  return auth
}

export function handleAuth(
  input: AuthRequestInput,
  runtimeOptions?: AuthRuntimeOptions,
): Promise<Response> {
  return handleAuthRequest(resolveDefaultDefinition(), input, runtimeOptions, input)
}

function wantsHtml(request: Pick<Request, "headers" | "method">): boolean {
  return request.method === "GET" && request.headers.get("accept")?.includes("text/html") === true
}

function createForbiddenResponse(request: Pick<Request, "headers" | "method">): Response {
  return wantsHtml(request)
    ? new Response("Forbidden.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
        status: 403,
      })
    : Response.json({ error: "Forbidden." }, { status: 403 })
}

function authAccessRoutes(
  options: AuthRuntimeOptions & Record<string, unknown>,
  routeIndexes: number[],
): AuthAccessRoute[] {
  // SAFETY: Auth Definitions validate `access` before the runtime resolves their options.
  const routes = (options as { access?: AuthAccessConfiguration }).access?.routes
  return routeIndexes.map((routeIndex) => {
    const route = routes?.[routeIndex]
    if (!route) {
      throw authErrorDiagnostics.AUTH_R0008({ message: `[vitehub] Auth access route ${routeIndex} is unavailable at runtime.` })
    }
    return route
  })
}

async function createSignInResponse(
  auth: ViteHubAuth,
  options: AuthRuntimeOptions & Record<string, unknown>,
  signIn: AuthSignInConfiguration,
): Promise<Response> {
  // SAFETY: The request resolver supplies baseURL from the runtime configuration or request origin.
  const origin = new URL(options.baseURL as string).origin
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- basePath comes from Definition metadata carried alongside Better Auth runtime options.
  const basePath = resolveAuthMountPath(normalizeAuthBasePath(typeof options.basePath === "string" ? options.basePath : undefined))
  const response = await auth.handler(new Request(`${origin}${basePath}/sign-in/social`, {
    body: JSON.stringify({
      callbackURL: signIn.callbackURL,
      errorCallbackURL: signIn.errorCallbackURL,
      provider: signIn.provider,
      requestSignUp: signIn.requestSignUp,
      scopes: signIn.scopes,
    }),
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "origin": origin,
    },
    method: "POST",
  }))

  if (!response.ok) return response

  const body = await response.json().catch(() => undefined) as { url?: unknown } | undefined
  if (typeof body?.url !== "string") {
    return Response.json({ error: "Auth sign-in did not return a redirect URL." }, { status: 502 })
  }

  const headers = new Headers(response.headers)
  headers.delete("content-type")
  headers.set("location", body.url)
  return new Response(null, { headers, status: 302 })
}

async function readRequestSession(input: AuthRequestInput, definition: AuthDefinition) {
  const request = unwrapAuthRequest(input)
  const { options, providerOptions } = resolveAuthOptions(definition, { request, event: input, env: getAuthRuntimeEnvResolver() })
  const auth = createAuthenticationProvider(providerOptions)
  const session = await getAuthenticationSession(auth, { headers: request.headers })
  return { auth, options, request, session }
}

type AuthCheck =
  | { authorization: AuthAuthorization, response?: undefined }
  | { authorization?: undefined, response: Response }

function reject(response: Response): AuthCheck {
  return { response }
}

function responseGetter(value: object, property: string): (() => unknown) | undefined {
  let prototype: object | null = value
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property)
    if (descriptor?.get) return descriptor.get
    prototype = Object.getPrototypeOf(prototype) as object | null
  }
}

function responseMethod(value: object, property: string): ((this: object) => unknown) | undefined {
  if (Object.prototype.hasOwnProperty.call(value, property)) return
  let prototype: object | null = Object.getPrototypeOf(value) as object | null
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property)
    if (typeof descriptor?.value === "function") return descriptor.value as (this: object) => unknown
    prototype = Object.getPrototypeOf(prototype) as object | null
  }
  return
}

async function runAccessAuthorize(
  authorize: AuthAccessAuthorize,
  context: AuthAccessAuthorizationContext,
): Promise<Response | undefined> {
  const result = authorize(context)
  if (result === true) return
  // Normalize an already-returned native Response before awaiting it. This
  // avoids assimilating an own `then` property on the Response object.
  let response = await normalizeAuthorizationResponse(result)
  if (!response) {
    const resolved = await adoptAuthorizationPromise(result)
    if (resolved === true) return
    response = await normalizeAuthorizationResponse(resolved)
  }
  if (response) return response
  return createForbiddenResponse(context.request)
}

async function adoptAuthorizationPromise(value: unknown): Promise<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return await value
  let adopted: Promise<unknown> | undefined
  try {
    adopted = new Promise((resolve, reject) => {
      Reflect.apply(intrinsicPromiseThen, value, [resolve, reject])
    })
  }
  catch (error) {
    // Promise.prototype.then rejects ordinary thenables as incompatible
    // receivers. Preserve their normal assimilation semantics instead of
    // trying to apply the native Promise path to every object.
    let nativePromise = false
    try {
      nativePromise = Object.prototype.toString.call(value) === "[object Promise]"
    }
    catch {
      nativePromise = false
    }
    if (!nativePromise) return await value
    // Promise subclasses can expose a throwing species getter. Retry the
    // intrinsic adoption with the standard constructor, restoring the object
    // immediately after the intrinsic has captured it.
    const descriptor = Object.getOwnPropertyDescriptor(value, "constructor")
    try {
      Object.defineProperty(value, "constructor", { configurable: true, value: Promise })
      adopted = new Promise((resolve, reject) => {
        Reflect.apply(intrinsicPromiseThen, value, [resolve, reject])
      })
    }
    catch {
      return await value
    }
    finally {
      if (descriptor) Object.defineProperty(value, "constructor", descriptor)
      else Reflect.deleteProperty(value, "constructor")
    }
    if (!adopted) throw error
  }
  return adopted
}

const authorizationResponseProperties = ["status", "statusText", "headers", "body"] as const

const authorizationResponsePrototypeLimit = 32

function responsePropertyDescriptor(value: unknown, key: PropertyKey): PropertyDescriptor | undefined {
  try {
    let current: object | null = Object(value)
    const seen = new Set<object>()
    for (let depth = 0; current && depth < authorizationResponsePrototypeLimit; depth++) {
      if (seen.has(current)) throw new Error("Cyclic authorization response prototype")
      seen.add(current)
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor) return descriptor
      current = Object.getPrototypeOf(current)
    }
    if (current) throw new Error("Authorization response prototype chain is too deep")
  }
  catch {
    // Fail the whole snapshot rather than treating malformed reflection as a missing method.
    throw new Error("Malformed authorization response prototype")
  }
}

let undiciResponsePromise: Promise<typeof Response | undefined> | undefined
let undiciHeadersPromise: Promise<typeof Headers | undefined> | undefined

async function getUndiciResponse(): Promise<typeof Response | undefined> {
  if (undiciResponsePromise) return undiciResponsePromise
  undiciResponsePromise = import(/* @vite-ignore */ "undici")
    .then(module => module.Response as typeof Response)
    .catch(() => undefined)
  return undiciResponsePromise
}

async function getUndiciHeaders(): Promise<typeof Headers | undefined> {
  if (undiciHeadersPromise) return undiciHeadersPromise
  undiciHeadersPromise = import(/* @vite-ignore */ "undici")
    .then(module => module.Headers as typeof Headers)
    .catch(() => undefined)
  return undiciHeadersPromise
}

async function hasResponsePrototype(value: unknown): Promise<boolean> {
  const UndiciResponse = await getUndiciResponse()
  try {
    let current: object | null = Object.getPrototypeOf(Object(value))
    const seen = new Set<object>()
    for (let depth = 0; current && depth < authorizationResponsePrototypeLimit; depth++) {
      const target = current === Response.prototype ? Response : UndiciResponse
      if (target) {
        const getter = Object.getOwnPropertyDescriptor(target.prototype, "status")?.get
        if (getter) {
          try {
            Reflect.apply(getter, value, [])
            return true
          }
          catch {
            // This prototype may belong to another Response implementation;
            // continue walking until the owning native prototype is reached.
          }
        }
      }
      if (seen.has(current)) return false
      seen.add(current)
      current = Object.getPrototypeOf(current)
    }
    return false
  }
  catch { return false }
}

function isNativeFunction(value: unknown): value is (...args: never[]) => unknown {
  if (typeof value !== "function") return false
  try {
    return Function.prototype.toString.call(value).includes("[native code]")
  }
  catch {
    return false
  }
}

function getNativeAuthorizationBodyReader(body: unknown): ((this: object) => ReadableStreamDefaultReader<Uint8Array>) | false | undefined {
  if (body === null || typeof body !== "object") return
  try {
    if (Object.prototype.hasOwnProperty.call(body, "getReader")) return false
    const streamDescriptors = getNativeAuthorizationStreamDescriptors(body)
    if (!streamDescriptors) return false
    // Response construction performs the native disturbed/locked stream check.
    // Probe before acquiring a reader so an already-consumed foreign body fails
    // closed without changing the source stream state.
    try { new Response(body as ReadableStream<Uint8Array>) }
    catch { return false }
    const getReader = streamDescriptors.getReader
    const reader = Reflect.apply(getReader, body, [])
    const methods = getNativeAuthorizationReaderMethods(reader)
    if (!methods) return false
    Reflect.apply(methods.releaseLock, reader, [])
    return getReader
  }
  catch {
    return false
  }
}

function isSerializableAuthorizationBody(body: unknown): body is ReadableStream<Uint8Array> | null {
  if (body === null) return true
  if (Object(body) !== body) return false
  const streamDescriptors = getNativeAuthorizationStreamDescriptors(body as object)
  if (!streamDescriptors || Reflect.apply(streamDescriptors.locked, body, [])) return false
  return true
}

function getNativeAuthorizationStreamDescriptors(body: object) {
  try {
    // Host ReadableStream intrinsics perform an internal-slot check that works
    // across realms and cannot be forged by an interposed prototype.
    const getReader = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "getReader")?.value
    const locked = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")?.get
    if (typeof getReader !== "function" || typeof locked !== "function") return
    Reflect.apply(locked, body, [])
    return {
      getReader: getReader as (this: object) => ReadableStreamDefaultReader<Uint8Array>,
      locked: locked as (this: object) => boolean,
    }
  }
  catch {
    return
  }
}

function getNativeAuthorizationReaderMethods(reader: object) {
  const prototype = Object.getPrototypeOf(reader)
  if (!prototype || typeof prototype !== "object") return
  const closed = Object.getOwnPropertyDescriptor(prototype, "closed")?.get
  const read = Object.getOwnPropertyDescriptor(prototype, "read")?.value
  const cancel = Object.getOwnPropertyDescriptor(prototype, "cancel")?.value
  const releaseLock = Object.getOwnPropertyDescriptor(prototype, "releaseLock")?.value
  if (typeof closed !== "function" || typeof read !== "function" || typeof cancel !== "function" || typeof releaseLock !== "function") return
  // Intrinsic methods perform the reader brand check and cannot be shadowed by the source object.
  Reflect.apply(closed, reader, [])
  return { read, cancel, releaseLock }
}

function releaseAuthorizationReader(reader: unknown): void {
  if (Object(reader) !== reader) return
  let prototype: object | null = Object.getPrototypeOf(reader)
  const seen = new Set<object>()
  for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
    if (seen.has(prototype)) return
    seen.add(prototype)
    const releaseLock = Object.getOwnPropertyDescriptor(prototype, "releaseLock")?.value
    if (typeof releaseLock === "function") {
      try { Reflect.apply(releaseLock, reader, []) } catch { /* best effort during initialization failure */ }
      return
    }
    prototype = Object.getPrototypeOf(prototype)
  }
}

function bridgeAuthorizationBody(
  body: ReadableStream<Uint8Array>,
  getReader: (this: object) => ReadableStreamDefaultReader<Uint8Array>,
  initialReader?: ReadableStreamDefaultReader<Uint8Array>,
) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined = initialReader
  let initializing: Promise<ReadableStreamDefaultReader<Uint8Array>> | undefined
  let read: ((...args: []) => Promise<{ done: boolean; value: Uint8Array }>) | undefined
  let cancel: ((...args: [unknown?]) => Promise<void>) | undefined
  let releaseLock: (() => void) | undefined
  let released = false
  const initializeReader = (acquired: unknown) => {
    if (Object(acquired) !== acquired || Object.prototype.hasOwnProperty.call(acquired, "read") || Object.prototype.hasOwnProperty.call(acquired, "cancel") || Object.prototype.hasOwnProperty.call(acquired, "releaseLock")) throw new Error("Malformed authorization reader")
    let prototype: object | null = Object.getPrototypeOf(acquired)
    const seen = new Set<object>()
    for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (seen.has(prototype)) break
      seen.add(prototype)
      const readDescriptor = Object.getOwnPropertyDescriptor(prototype, "read")
      const cancelDescriptor = Object.getOwnPropertyDescriptor(prototype, "cancel")
      const releaseDescriptor = Object.getOwnPropertyDescriptor(prototype, "releaseLock")
      read ??= typeof readDescriptor?.value === "function" ? readDescriptor.value : undefined
      cancel ??= typeof cancelDescriptor?.value === "function" ? cancelDescriptor.value : undefined
      releaseLock ??= typeof releaseDescriptor?.value === "function" ? releaseDescriptor.value : undefined
      if (read && cancel && releaseLock) break
      prototype = Object.getPrototypeOf(prototype)
    }
    if (!read || !cancel || !releaseLock) throw new Error("Malformed authorization reader")
    return acquired as ReadableStreamDefaultReader<Uint8Array>
  }
  if (initialReader) {
    try { initializeReader(initialReader) }
    catch (error) {
      releaseAuthorizationReader(initialReader)
      throw error
    }
  }
  const acquire = async () => {
    if (reader) return reader
    initializing ??= Promise.resolve().then(() => {
      const acquired = Reflect.apply(getReader, body, [])
      try { return initializeReader(acquired) }
      catch (error) {
        releaseAuthorizationReader(acquired)
        throw error
      }
    })
    reader = await initializing
    return reader
  }
  const release = () => {
    if (released || !reader || !releaseLock) return
    released = true
    Reflect.apply(releaseLock, reader, [])
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const sourceReader = await acquire()
        const result = await Reflect.apply(read!, sourceReader, [])
        if (typeof result.done !== "boolean") throw new Error("Malformed authorization read result")
        if (result.done) { release(); controller.close() }
        else if (!isIntrinsicUint8Array(result.value)) { release(); controller.error(new Error("Malformed authorization read result")) }
        else controller.enqueue(new Uint8Array(result.value))
      } catch (error) { release(); controller.error(error) }
    },
    async cancel(reason) {
      try {
        const sourceReader = reader ?? await acquire()
        await Reflect.apply(cancel!, sourceReader, [reason])
      } finally { release() }
    },
  }, { highWaterMark: 0 })
  return { stream, release, ready: getReader === ReadableStream.prototype.getReader ? undefined : acquire() }
}

async function normalizeAuthorizationResponse(value: unknown): Promise<Response | undefined> {
  if (value === null || Object(value) !== value) return
  try {
    const candidate = Object(value)
    if (!await hasResponsePrototype(candidate)) return
    const descriptors = Object.fromEntries(authorizationResponseProperties.map((key) => {
      const descriptor = responsePropertyDescriptor(candidate, key)
      if (typeof descriptor?.get !== "function") throw new Error("Malformed authorization response")
      return [key, descriptor.get]
    })) as Record<(typeof authorizationResponseProperties)[number], (...args: never[]) => unknown>
    const status: unknown = Reflect.apply(descriptors.status, candidate, [])
    const statusText: unknown = Reflect.apply(descriptors.statusText, candidate, [])
    const headers: unknown = Reflect.apply(descriptors.headers, candidate, [])
    const body: unknown = Reflect.apply(descriptors.body, candidate, [])
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- A response snapshot needs an integer HTTP status before constructing the local Response.
    if (typeof status !== "number" || !Number.isInteger(status) || (status !== 0 && (status < 200 || status > 599))) return
    if (typeof statusText !== "string") return
    if (headers === null || Object(headers) !== headers) return
    // A same-realm Response is already a trusted, usable result. Return it
    // before probing its body: consumed and locked native bodies are still
    // required to pass through unchanged.
    if (value instanceof Response && headers instanceof Headers
      && !Boolean(Object.getOwnPropertyDescriptor(Response.prototype, "bodyUsed")?.get
        && Reflect.apply(Object.getOwnPropertyDescriptor(Response.prototype, "bodyUsed")!.get!, candidate, []))
      && authorizationResponseProperties.every(key => {
        const ownDescriptor = Object.getOwnPropertyDescriptor(candidate, key)
        const nativeGetter = Object.getOwnPropertyDescriptor(Response.prototype, key)?.get
        if (ownDescriptor) return ownDescriptor.get === nativeGetter && ownDescriptor.set === undefined
        return responsePropertyDescriptor(candidate, key)?.get === nativeGetter
      })) return value
    // Response construction rejects bodies for these status codes. Check this
    // before transferring a foreign stream so a rejected candidate retains
    // ownership of its original body.
    if (body !== null && (status === 204 || status === 205 || status === 304)) return

    const headerCarrier = Object(headers)
    // Require the Headers internal slots before accepting a response snapshot.
    // Method names and prototypes can be forged, but native brand operations fail
    // unless the value was created by a Web Headers implementation.
    const headersGet = responsePropertyDescriptor(headerCarrier, "get")?.value
    const headersForEach = responsePropertyDescriptor(headerCarrier, "forEach")?.value
    if (typeof headersGet !== "function" || typeof headersForEach !== "function") return
    let headerNativePrototype = Object.getPrototypeOf(headerCarrier)
    const seenHeaderPrototypes = new Set<object>()
    for (let depth = 0; headerNativePrototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (seenHeaderPrototypes.has(headerNativePrototype)) return
      seenHeaderPrototypes.add(headerNativePrototype)
      const getDescriptor = Object.getOwnPropertyDescriptor(headerNativePrototype, "get")
      const forEachDescriptor = Object.getOwnPropertyDescriptor(headerNativePrototype, "forEach")
      if (getDescriptor?.value === headersGet && forEachDescriptor?.value === headersForEach) break
      headerNativePrototype = Object.getPrototypeOf(headerNativePrototype)
    }
    if (!headerNativePrototype || !seenHeaderPrototypes.has(headerNativePrototype)) return
    // The local Web API methods perform an internal-slot check. This rejects
    // self-consistent forged prototypes while still allowing implementations
    // whose own methods expose the same Headers data to be copied below.
    let branded = false
    let trustedGet: ((this: Headers, name: string) => string | null) | undefined
    let trustedForEach: ((this: Headers, callback: (value: string, key: string) => void) => void) | undefined
    let trustedGetSetCookie: ((this: Headers) => string[]) | undefined
    // Only intrinsics obtained from trusted runtime integration may establish
    // the Headers brand. A constructor supplied by the candidate is fully
    // attacker-controlled, even when its prototype is self-consistent.
    const headerTargets: (typeof Headers)[] = [Headers]
    const UndiciHeaders = await getUndiciHeaders()
    if (UndiciHeaders) headerTargets.push(UndiciHeaders)
    for (const HeaderCtor of headerTargets) {
      try {
        const get = Object.getOwnPropertyDescriptor(HeaderCtor.prototype, "get")!.value as typeof trustedGet
        const forEach = Object.getOwnPropertyDescriptor(HeaderCtor.prototype, "forEach")!.value as typeof trustedForEach
        const getSetCookie = Object.getOwnPropertyDescriptor(HeaderCtor.prototype, "getSetCookie")?.value as typeof trustedGetSetCookie
        if (typeof get !== "function" || typeof forEach !== "function") continue
        Reflect.apply(get, headers, ["content-type"])
        Reflect.apply(forEach, headers, [() => {}])
        branded = true
        trustedGet = get
        trustedForEach = forEach
        trustedGetSetCookie = typeof getSetCookie === "function" ? getSetCookie : undefined
        break
      }
      catch { /* try the next realm's intrinsic */ }
    }
    // Do not fall back to invoking methods supplied by the candidate. Those
    // methods are ordinary JavaScript and can be forged to look self-consistent;
    // only trusted Web intrinsics provide a non-spoofable internal-slot check.
    if (!branded) return
    if (!trustedForEach) return
    const snapshot = { status, statusText, headers, body }
    if (value instanceof Response && status === 0 && statusText === "" && body === null
      && headers instanceof Headers
      && authorizationResponseProperties.every(key =>
        responsePropertyDescriptor(candidate, key)?.get === Object.getOwnPropertyDescriptor(Response.prototype, key)?.get)
      && !authorizationResponseProperties.some(key => Object.prototype.hasOwnProperty.call(candidate, key))) return value
    const nativeDescriptors = value instanceof Response && authorizationResponseProperties.every(key =>
      responsePropertyDescriptor(candidate, key)?.get === Object.getOwnPropertyDescriptor(Response.prototype, key)?.get)
    let nativeProperties = false
    let nativeBodyUnused = false
    try {
      nativeProperties = nativeDescriptors && authorizationResponseProperties.every(key => {
        const getter = Object.getOwnPropertyDescriptor(Response.prototype, key)?.get
        return getter && Reflect.apply(getter, candidate, []) === snapshot[key]
      })
      const bodyUsedGetter = Object.getOwnPropertyDescriptor(Response.prototype, "bodyUsed")?.get
      const lockedGetter = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")?.get
      nativeBodyUnused = Boolean(bodyUsedGetter && !Reflect.apply(bodyUsedGetter, candidate, []))
        && (body === null || Boolean(lockedGetter && !Reflect.apply(lockedGetter, body, [])))
    }
    catch {
      // A proxy can expose native descriptors without owning native response state.
    }
    // The trusted brand probe above establishes native Header internal slots;
    // method identities may legitimately differ across Web realms.
    // Only invoke the intrinsic selected by the trusted Headers brand probe.
    // Candidate-owned accessors may be overridden by subclasses or proxies.
    const ownCookieDescriptor = Object.getOwnPropertyDescriptor(headers, "getSetCookie")
    let cookieAccessor = trustedGetSetCookie
    if (ownCookieDescriptor) {
      if ("value" in ownCookieDescriptor) {
        if (ownCookieDescriptor.value === undefined) cookieAccessor = undefined
        else return
      }
      else return
    }
    const cookies: unknown = typeof cookieAccessor === "function" ? Reflect.apply(cookieAccessor, headers, []) : []
    if (!Array.isArray(cookies)) return
    const normalizedHeaders = new Headers()
    let combinedCookies: string | undefined
    Reflect.apply(trustedForEach, headers, [(value: string, key: string) => {
      if (key.toLowerCase() === "set-cookie") {
        if (cookies.length === 0) combinedCookies = value
        return
      }
      normalizedHeaders.append(key, value)
    }])
    // Preserve one cookie when the fallback exposes only a combined value. A comma
    // followed by another cookie assignment at the cookie-pair boundary proves that
    // multiple values were merged. Assignment-like text after an extension attribute
    // can still be part of that attribute's value, so do not reject it as a merge.
    if (combinedCookies !== undefined) {
      if (ownCookieDescriptor && "value" in ownCookieDescriptor && ownCookieDescriptor.value === undefined) return
      const mergedCookie = /^[^;]*,[\s]*[^;=,\s]+\s*=/.test(combinedCookies)
        || /;\s*expires\s*=\s*[A-Za-z]{3},\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT(?:\s*;\s*[^,;]+(?:=\s*[^,;]*)?)*\s*,\s*[^;=,\s]+\s*=/i.test(combinedCookies)
      if (mergedCookie) return
      normalizedHeaders.append("set-cookie", combinedCookies)
    }
    for (const cookie of cookies) normalizedHeaders.append("set-cookie", cookie)

    const bodyReader = await getNativeAuthorizationBodyReader(body)
    if (body !== null && (bodyReader === false || bodyReader === undefined)) return

    // Preserve the standard error response before constructing a local response.
    if (status === 0 && statusText === "" && body === null && [...normalizedHeaders].length === 0) {
      if (nativeProperties && nativeBodyUnused && value instanceof Response) return value
      return Response.error()
    }
    if (body === null) return new Response(null, { status, statusText, headers: normalizedHeaders })
    if (body === null || typeof bodyReader !== "function") return
    const bridgedBody = bridgeAuthorizationBody(body as ReadableStream<Uint8Array>, bodyReader)
    try {
      return new Response(bridgedBody.stream, { status, statusText, headers: normalizedHeaders })
    }
    catch (error) {
      bridgedBody.release()
      throw error
    }

  }
  catch {
    return
  }
}

async function checkAuthRequest(
  input: AuthRequestInput,
  definition: AuthDefinition,
  routeIndexes?: number[],
  requiredAuthorizeRouteIndexes: number[] = [],
  redirectToSignIn = true,
): Promise<AuthCheck> {
  const { auth, options, request, session } = await readRequestSession(input, definition)
  if (session) {
    const authorization: AuthAuthorization = Object.freeze({
      request,
      session: session.session,
      user: session.user,
    })
    if (routeIndexes === undefined) return { authorization }

    const requiredAuthorizeRoutes = new Set(requiredAuthorizeRouteIndexes)
    const routes = authAccessRoutes(options, routeIndexes)
    for (const [index, route] of routes.entries()) {
      const authorize = typeof route === "object" && route !== null ? route.authorize : undefined
      if (!authorize && requiredAuthorizeRoutes.has(routeIndexes[index]!)) {
        return reject(createForbiddenResponse(request))
      }
      if (!authorize) continue
      const rejection = await runAccessAuthorize(authorize, authorization)
      if (rejection) return reject(rejection)
    }
    return { authorization }
  }

  if (!wantsHtml(request)) {
    return reject(Response.json({ error: "Unauthorized." }, { status: 401 }))
  }

  if (!redirectToSignIn) {
    return reject(Response.json({ error: "Unauthorized." }, { status: 401 }))
  }

  if (new URL(request.url).searchParams.has("auth_error")) {
    return reject(new Response("Unauthorized.", {
      headers: { "content-type": "text/plain; charset=utf-8" },
      status: 403,
    }))
  }

  const signIn = (options as { access?: AuthAccessConfiguration }).access?.signIn
  return reject(signIn
    ? await createSignInResponse(auth, options, signIn)
    : Response.json({ error: "Unauthorized." }, { status: 401 }))
}

async function checkAuthorizeRequest(
  input: AuthRequestInput,
  authorize: AccessAuthorizeOption,
  definition: AuthDefinition,
): Promise<AuthCheck> {
  const { request, session } = await readRequestSession(input, definition)
  if (!session) return reject(Response.json({ error: "Unauthorized." }, { status: 401 }))
  const authorization: AuthAuthorization = Object.freeze({ request, session: session.session, user: session.user })
  if (authorize === true) return { authorization }
  const rejection = await runAccessAuthorize(authorize, authorization)
  return rejection ? reject(rejection) : { authorization }
}

/**
 * Wraps a server handler so it runs only with a signed-in Auth Session.
 * The handler receives the checked `authorization`. Otherwise the wrapper returns `401`, or starts `access.signIn` for HTML requests.
 */
export function withAuth<TInput extends AuthRequestInput, TResult>(
  handler: AuthGuardedHandler<TInput, TResult>,
  definition?: AuthDefinition,
): (input: TInput) => Promise<TResult | Response> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The public handler boundary accepts callable callbacks from any JavaScript realm.
  if (typeof handler !== "function") {
    throw authErrorDiagnostics.AUTH_R0015({ message: "[vitehub] withAuth() requires a handler function." })
  }
  return async (input) => {
    const check = await checkAuthRequest(input, definition ?? resolveDefaultDefinition())
    if (check.response) return check.response
    return handler(input, check.authorization)
  }
}

/**
 * Wraps a resource handler, such as a Blob serve route or a Collection, so it runs only after `authorize` accepts the request.
 * Returns `401` without a session, `403` when `authorize` returns `false`, and a custom `Response` as-is.
 * It never redirects to sign-in, so image and fetch requests receive a status code.
 */
export function withAuthorization<TInput extends AuthRequestInput, TResult>(
  authorize: AccessAuthorizeOption,
  handler: AuthGuardedHandler<TInput, TResult>,
  definition?: AuthDefinition,
): (input: TInput) => Promise<TResult | Response> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The public authorization boundary accepts callable callbacks from any JavaScript realm.
  if (authorize !== true && typeof authorize !== "function") {
    throw authErrorDiagnostics.AUTH_R0014({ message: "[vitehub] `authorize` must be true or a function." })
  }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The public handler boundary accepts callable callbacks from any JavaScript realm.
  if (typeof handler !== "function") {
    throw authErrorDiagnostics.AUTH_R0015({ message: "[vitehub] withAuthorization() requires a handler function." })
  }
  return async (input) => {
    const check = await checkAuthorizeRequest(input, authorize, definition ?? resolveDefaultDefinition())
    if (check.response) return check.response
    return handler(input, check.authorization)
  }
}

/** Bind discovered access routes to a Web Request or host request handler. */
export function createAuthAccessHandler(
  routes: readonly ResolvedAuthAccessRoute[],
  definition?: AuthDefinition,
): (input: AuthRequestInput) => Promise<Response | undefined> {
  const rules = routes.map((route, index) => ({
    index,
    authorize: route.authorize === true,
    method: route.method?.toUpperCase(),
    path: resolveAuthMountPath(route.route.endsWith("/**") ? route.route.slice(0, -3) : route.route),
    recursive: route.route.endsWith("/**"),
  }))

  return async (input) => {
    const request = unwrapAuthRequest(input)
    const pathname = new URL(request.url).pathname
    const method = request.method.toUpperCase()
    const matched = rules.filter(rule => (!rule.method || rule.method === method)
      && (pathname === rule.path || (rule.recursive && pathname.startsWith(`${rule.path}/`))))
    if (matched.length === 0) return

    const { response } = await checkAuthRequest(
      input,
      definition ?? resolveDefaultDefinition(),
      matched.map(rule => rule.index),
      matched.filter(rule => rule.authorize).map(rule => rule.index),
    )
    return response
  }
}

export async function requireAuthAccessRoutes(
  input: AuthRequestInput,
  routeIndexes: number[],
  definition: AuthDefinition = resolveDefaultDefinition(),
  requiredAuthorizeRouteIndexes: number[] = [],
  options: { redirectToSignIn?: boolean } = {},
): Promise<Response | undefined> {
  if (!Array.isArray(routeIndexes) || routeIndexes.length === 0 || routeIndexes.some(routeIndex => !Number.isSafeInteger(routeIndex) || routeIndex < 0)) {
    throw authErrorDiagnostics.AUTH_R0009({ message: "[vitehub] Auth access route indexes must be a non-empty array of non-negative integers." })
  }
  if (!Array.isArray(requiredAuthorizeRouteIndexes) || requiredAuthorizeRouteIndexes.some(routeIndex => !Number.isSafeInteger(routeIndex) || routeIndex < 0)) {
    throw authErrorDiagnostics.AUTH_R0010({ message: "[vitehub] Required Auth authorize route indexes must be an array of non-negative integers." })
  }
  const { response } = await checkAuthRequest(input, definition, routeIndexes, requiredAuthorizeRouteIndexes, options.redirectToSignIn !== false)
  return response
}

export default handleAuth

export const auth = new Proxy({}, {
  get(_target, property, receiver) {
    return Reflect.get(getAuth() as object, property, receiver)
  },
  getOwnPropertyDescriptor(_target, property) {
    return Reflect.getOwnPropertyDescriptor(getAuth() as object, property)
  },
  has(_target, property) {
    return Reflect.has(getAuth() as object, property)
  },
  ownKeys() {
    return Reflect.ownKeys(getAuth() as object)
  },
}) as ViteHubAuth
