import discoveredDefinition from "#vitehub/auth/definition"
import { betterAuth } from "better-auth"
import { normalizeAuthBasePath } from "./shared.ts"
import { unwrapAuthRequest } from "./request.ts"
import { resolveAuthOptions } from "./runtime-options.ts"
import { throwAuthenticationProviderError } from "./errors.ts"
import { getAuthenticationSession } from "./session.ts"
import { getAuthRuntimeState } from "./runtime-state.ts"
import { resolveAuthMountPath } from "./application-path.ts"

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

export { resetAuth } from "./runtime-state.ts"

declare const __VITEHUB_PUBLIC_URL__: PublicUrlConfig | undefined

type AuthRuntimeEnvResolver = (event?: unknown) => Record<string, unknown>

function isCallable(value: unknown): value is (...args: never[]) => unknown {
  try {
    Reflect.apply(Function.prototype.toString, value, [])
    return true
  }
  catch {
    return false
  }
}

function hasRuntimeOptions(options: AuthRuntimeOptions | undefined): boolean {
  return Boolean(options && Object.keys(options).length > 0)
}

function hasRequestRuntimeOptions(definition: AuthDefinition): boolean {
  if (typeof definition.options === "function") return true
  return typeof definition.options.runtime === "function"
}

function hasConfiguredPublicUrl(): boolean {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The build injects this value only when `vitehub({ publicUrl })` is set.
  return typeof __VITEHUB_PUBLIC_URL__ !== "undefined"
    && Boolean(__VITEHUB_PUBLIC_URL__?.url || Object.keys(__VITEHUB_PUBLIC_URL__?.agents ?? {}).length)
}

export function setAuthRuntimeEnvResolver(resolver: AuthRuntimeEnvResolver | undefined): void {
  getAuthRuntimeState().envResolver = resolver
}

function getAuthRuntimeEnvResolver(): AuthRuntimeEnvResolver | undefined {
  return getAuthRuntimeState().envResolver
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

const nativeResponseConstructor = Response
const nativeResponsePrototype = Response.prototype

async function runAccessAuthorize(
  authorize: AuthAccessAuthorize,
  context: AuthAccessAuthorizationContext,
): Promise<Response | undefined> {
  const result = await authorize(context)
  const response = await normalizeAuthorizationResponse(result)
  if (response) return response
  if (result !== true) return createForbiddenResponse(context.request)
}

const authorizationResponseProperties = ["status", "statusText", "headers", "body"] as const

// Capture the platform accessors before user authorization code can mutate the
// global prototype.  Later provenance checks must compare against these stable
// references rather than whatever descriptors happen to be installed now.
const trustedResponseGetters = Object.fromEntries(
  authorizationResponseProperties.map(key => [key, Object.getOwnPropertyDescriptor(Response.prototype, key)?.get]),
) as Record<typeof authorizationResponseProperties[number], (() => unknown) | undefined>

function hasTrustedResponseDescriptors(prototype: object): boolean {
  return authorizationResponseProperties.every(key =>
    Object.getOwnPropertyDescriptor(prototype, key)?.get === trustedResponseGetters[key])
}

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

async function getUndiciResponse(): Promise<typeof Response | undefined> {
  if (undiciResponsePromise) return undiciResponsePromise
  undiciResponsePromise = import(/* @vite-ignore */ "undici")
    .then(module => module.Response as typeof Response)
    .catch(() => undefined)
  return undiciResponsePromise
}

async function hasResponsePrototype(value: unknown, localResponsePrototype: object): Promise<boolean> {
  const targets = new Set<object>([localResponsePrototype])
  const UndiciResponse = await getUndiciResponse()
  if (UndiciResponse) targets.add(UndiciResponse.prototype)
  try {
    let current = Object.getPrototypeOf(Object(value))
    const seen = new Set<object>()
    let shadowedResponseProperties = false
    for (let depth = 0; current && depth < authorizationResponsePrototypeLimit; depth++) {
      const prototype = current
      if (targets.has(prototype)) {
        if (prototype === localResponsePrototype && !hasTrustedResponseDescriptors(prototype)) return false
        return !shadowedResponseProperties
      }
      if (seen.has(prototype)) return false
      seen.add(prototype)
      const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
      const owner = prototype
      const constructorSource = typeof constructor === "function" ? Function.prototype.toString.call(constructor) : ""
      // A user-defined `class Response` is indistinguishable from a foreign
      // platform constructor by source shape alone.  Known local/Undici
      // prototypes are handled by `targets`; only native constructors may
      // authenticate an otherwise unknown runtime prototype.
      const platformConstructor = constructor?.name === "Response" && constructorSource.includes("[native code]")
      const platformGetters = authorizationResponseProperties.every((key) => {
        const getter = Object.getOwnPropertyDescriptor(owner, key)?.get
        if (typeof getter !== "function") return false
        const getterSource = Function.prototype.toString.call(getter)
        if (!getterSource.includes("webidl.brandCheck(") && !getterSource.includes("[native code]")) return false
        try { Reflect.apply(getter, Object.create(owner), []) ; return false }
        catch { try { Reflect.apply(getter, value, []); return true } catch { return false } }
      })
      const ownSnapshot = authorizationResponseProperties.every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        return descriptor && "value" in descriptor
      })
      if (platformConstructor && !ownSnapshot && platformGetters && !shadowedResponseProperties) return true
      if (authorizationResponseProperties.some((key) => Object.hasOwn(owner, key))) shadowedResponseProperties = true
      current = Object.getPrototypeOf(prototype)
    }
    return false
  }
  catch {
    return false
  }
}

function isSerializableAuthorizationBody(body: unknown): body is ReadableStream<Uint8Array> | null {
  if (body === null) return true
  if (Object(body) !== body) return false

  try {
    const candidate = Object(body)
    // Resolve the stream intrinsics from the body's own realm. Applying the
    // getter performs the brand check and works across JavaScript realms.
    if (Object.getOwnPropertyDescriptor(candidate, "getReader")) return false
    const locked = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")?.get
    const getReader = ReadableStream.prototype.getReader
    if (typeof locked !== "function" || typeof getReader !== "function") return false
    if (Reflect.apply(locked, candidate, [])) return false
    // The stream can be released after consumption, leaving `locked` false
    // while the stream is still disturbed.  Fetch's Response constructor
    // performs the platform disturbed-state check without taking ownership.
    new nativeResponseConstructor(candidate)
    // Validate the native reader against a fresh stream. The candidate's
    // inherited reader overrides are intentionally ignored.
    const freshStream = new ReadableStream()
    const reader = Reflect.apply(getReader, freshStream, [])
    if (Object(reader) !== reader) return false
    const readerObject = reader as object
    if (typeof Reflect.get(readerObject, "read") !== "function"
      || typeof Reflect.get(readerObject, "cancel") !== "function"
      || typeof Reflect.get(readerObject, "releaseLock") !== "function") return false
    Reflect.apply(Reflect.get(readerObject, "releaseLock"), readerObject, [])
    return true
  }
  catch {
    return false
  }
}

function authorizationBodyReader(body: object): (() => unknown) | undefined {
  let prototype: object | null = Object.getPrototypeOf(body)
  const seen = new Set<object>()
  let lockedOwner: object | undefined
  for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
    if (seen.has(prototype)) return
    seen.add(prototype)
    if (!lockedOwner && typeof Object.getOwnPropertyDescriptor(prototype, "locked")?.get === "function") lockedOwner = prototype
    if (lockedOwner === prototype) {
      const reader = Object.getOwnPropertyDescriptor(prototype, "getReader")?.value
      return typeof reader === "function" ? reader : undefined
    }
    prototype = Object.getPrototypeOf(prototype)
  }
}

const trustedUint8ArraySubarray = Uint8Array.prototype.subarray

function isIntrinsicUint8Array(value: unknown): value is Uint8Array {
  try {
    Reflect.apply(trustedUint8ArraySubarray, value, [0, 0])
    return true
  }
  catch {
    return false
  }
}

function bridgeAuthorizationBody(
  body: ReadableStream<Uint8Array>,
  getReader: () => unknown,
) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let initializing: Promise<ReadableStreamDefaultReader<Uint8Array>> | undefined
  let read: ((...args: []) => Promise<{ done: boolean; value: Uint8Array }>) | undefined
  let cancel: ((...args: [unknown?]) => Promise<void>) | undefined
  let releaseLock: (() => void) | undefined
  let released = false
  const acquire = async () => {
    initializing ??= Promise.resolve().then(() => {
      const acquired = Reflect.apply(getReader, body, [])
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
        else controller.enqueue(result.value)
      } catch (error) { release(); controller.error(error) }
    },
    async cancel(reason) {
      try {
        const sourceReader = reader ?? await acquire()
        await Reflect.apply(cancel!, sourceReader, [reason])
      } finally { release() }
    },
  }, { highWaterMark: 0 })
  return { stream, release }
}


async function normalizeAuthorizationResponse(value: unknown): Promise<Response | undefined> {
  if (value === null || Object(value) !== value) return
  try {
    const candidate = Object(value)
    const localResponsePrototype = nativeResponsePrototype
    const localResponseConstructor = nativeResponseConstructor
    if (!await hasResponsePrototype(candidate, localResponsePrototype)) return
    // Authenticate local Responses through their intrinsic getters before any
    // ordinary reads. Proxies and shadowed subclasses cannot satisfy these
    // private-brand checks and must fail closed instead of being normalized.
    if (value instanceof localResponseConstructor) {
      const nativeDescriptors = authorizationResponseProperties.every(key =>
        responsePropertyDescriptor(candidate, key)?.get === trustedResponseGetters[key])
      if (!nativeDescriptors) return
      try {
        for (const key of authorizationResponseProperties) {
          const getter = trustedResponseGetters[key]
          if (typeof getter !== "function") return
          Reflect.apply(getter, candidate, [])
        }
      }
      catch {
        return
      }
    }
    // Snapshot ordinary property reads once. Prototype shape is not proof of origin.
    const status: unknown = Reflect.get(candidate, "status")
    const statusText: unknown = Reflect.get(candidate, "statusText")
    const headers: unknown = Reflect.get(candidate, "headers")
    const body: unknown = Reflect.get(candidate, "body")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- A response snapshot needs an integer HTTP status before constructing the local Response.
    if (typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > 599) return
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Response status text is an opaque boundary string validated by the local Response constructor below.
    if (typeof statusText !== "string") return
    if (headers === null || Object(headers) !== headers) return

    const headerCarrier = Object(headers)
    const snapshot = { status, statusText, headers, body }
    const nativeDescriptors = value instanceof localResponseConstructor && authorizationResponseProperties.every(key =>
      responsePropertyDescriptor(candidate, key)?.get === trustedResponseGetters[key])
    let nativeProperties = false
    try {
      nativeProperties = nativeDescriptors && authorizationResponseProperties.every(key => {
        const getter = trustedResponseGetters[key]
        return getter && Reflect.apply(getter, candidate, []) === snapshot[key]
      })
    }
    catch {
      // A proxy can expose native descriptors without owning native response state.
    }
    const nativeHeaderMethods = ["get", "forEach"].every(key =>
      responsePropertyDescriptor(headerCarrier, key)?.value === Object.getOwnPropertyDescriptor(Headers.prototype, key)?.value)
    // A foreign implementation must carry its own native Headers methods.
    // Accepting a foreign Response prototype paired with current-realm Headers
    // would make a user-defined Response-shaped object indistinguishable from
    // a genuine cross-runtime response.
    const cookieDescriptor = responsePropertyDescriptor(headerCarrier, "getSetCookie")
    const nativeCookieMethod = !cookieDescriptor?.get && (cookieDescriptor?.value === undefined
      || cookieDescriptor.value === Object.getOwnPropertyDescriptor(Headers.prototype, "getSetCookie")?.value)
    const nativeBodyMethod = body === null || responsePropertyDescriptor(Object(body), "getReader")?.value === ReadableStream.prototype.getReader
    // Preserve an authenticated local Response even after its body is consumed or locked.
    // Body-state checks belong only to normalization, where we would otherwise take ownership.
    if (value instanceof localResponseConstructor && nativeProperties && nativeHeaderMethods && nativeCookieMethod && nativeBodyMethod) return value as Response
    if (!isSerializableAuthorizationBody(body)) return
    const forEach = Reflect.get(headerCarrier, "forEach")
    const getSetCookie = Reflect.get(headerCarrier, "getSetCookie")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Headers.getSetCookie is optional across runtimes; capture its result once when callable.
    const cookies: unknown = typeof getSetCookie === "function" ? Reflect.apply(getSetCookie, headers, []) : []
    if (!Array.isArray(cookies)) return
    const normalizedHeaders = new Headers()
    let combinedCookies: string | undefined
    Reflect.apply(forEach, headers, [(value: string, key: string) => {
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
      if (/^[^;]*,[\s]*[^;=,\s]+\s*=/.test(combinedCookies)) return
      normalizedHeaders.append("set-cookie", combinedCookies)
    }
    for (const cookie of cookies) normalizedHeaders.append("set-cookie", cookie)

    // Validate status and native body state before acquiring reader ownership.
    const normalizedResponse = status === 0 && statusText === "" && body === null && [...normalizedHeaders].length === 0
      ? Response.error()
      : new Response(body, { status, statusText, headers: normalizedHeaders })
    if (body === null) return normalizedResponse
    const bodyReader = authorizationBodyReader(body)
    if (!bodyReader) return
    const bridgedBody = bridgeAuthorizationBody(body, bodyReader)
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
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Route configuration crosses JavaScript realms; runtime object narrowing preserves foreign authorize callbacks.
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
  if (!(handler instanceof Function)) {
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
  if (authorize !== true && !isCallable(authorize)) {
    throw authErrorDiagnostics.AUTH_R0014({ message: "[vitehub] `authorize` must be true or a function." })
  }
  if (!(handler instanceof Function)) {
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
