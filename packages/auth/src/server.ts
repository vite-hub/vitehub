import discoveredDefinition from "#vitehub/auth/definition"
import { betterAuth } from "better-auth"
import { resolveAuthMountPath } from "./application-path.ts"
import { normalizeAuthBasePath } from "./shared.ts"
import { unwrapAuthRequest } from "./request.ts"
import { resolveAuthOptions } from "./runtime-options.ts"
import { throwAuthenticationProviderError } from "./errors.ts"
import { getAuthenticationSession } from "./session.ts"
import { getAuthRuntimeState } from "./runtime-state.ts"
import type { AuthRuntimeEnvResolver } from "./runtime-state.ts"

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
  return resolveAuthOptions(definition, { request, runtimeOptions, event, env: getAuthRuntimeState().envResolver }).requestRuntimeOptions
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
  return resolveAuthOptions(definition, { runtimeOptions, env: getAuthRuntimeState().envResolver }).providerOptions
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
  return betterAuth(resolveAuthOptions(definition, { request, runtimeOptions, event, env: getAuthRuntimeState().envResolver }).providerOptions) as ViteHubAuth
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
  return createAuthenticationProvider(resolveAuthOptions(definition, { request, runtimeOptions, event, env: getAuthRuntimeState().envResolver }).providerOptions)
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
  const { options, providerOptions } = resolveAuthOptions(definition, { request, event: input, env: getAuthRuntimeState().envResolver })
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

const nativeResponseStatus = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get

/**
 * Return whether `value` is a Response of this runtime.
 * The native `status` getter checks the internal Response slot, so a proxy, a copied prototype, an object tagged `Response`,
 * and a Response from another Fetch implementation all fail. The check reads no property of `value`.
 */
function isRuntimeResponse(value: unknown): value is Response {
  if (!nativeResponseStatus || value === null || typeof value !== "object") return false
  try {
    Reflect.apply(nativeResponseStatus, value, [])
    return true
  }
  catch {
    return false
  }
}

/**
 * Only `true` grants access. A Response of this runtime is sent as the rejection. Every other value gets `403`.
 */
async function runAccessAuthorize(
  authorize: AuthAccessAuthorize,
  context: AuthAccessAuthorizationContext,
): Promise<Response | undefined> {

  // Pin foreign runtime accessors before untrusted authorization code can mutate them.
  await getUndiciResponse()
  const result = await authorize(context)
  const response = await normalizeAuthorizationResponse(result)
  if (response) return response
  if (result !== true) return createForbiddenResponse(context.request)
}

const authorizationResponseProperties = ["status", "statusText", "headers", "body"] as const

const nativeResponseDescriptors = Object.fromEntries(authorizationResponseProperties.map(key => [
  key,
  Object.getOwnPropertyDescriptor(Response.prototype, key),
])) as Record<typeof authorizationResponseProperties[number], PropertyDescriptor | undefined>

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
let undiciResponseDescriptors: Record<typeof authorizationResponseProperties[number], PropertyDescriptor | undefined> | undefined

async function getUndiciResponse(): Promise<typeof Response | undefined> {
  if (undiciResponsePromise) return undiciResponsePromise
  undiciResponsePromise = import(/* @vite-ignore */ "undici")
    .then(module => {
      const constructor = module.Response as typeof Response
      undiciResponseDescriptors = Object.fromEntries(authorizationResponseProperties.map(key => [
        key,
        Object.getOwnPropertyDescriptor(constructor.prototype, key),
      ])) as Record<typeof authorizationResponseProperties[number], PropertyDescriptor | undefined>
      return constructor
    })
    .catch(() => undefined)
  return undiciResponsePromise
}

async function hasResponsePrototype(value: unknown): Promise<boolean> {
  const UndiciResponse = await getUndiciResponse()
  try {
    let current = Object.getPrototypeOf(Object(value))
    const seen = new Set<object>()
    for (let depth = 0; current && depth < authorizationResponsePrototypeLimit; depth++) {
      if (seen.has(current)) return false
      seen.add(current)
      const constructor = Object.getOwnPropertyDescriptor(current, "constructor")?.value
      const accessors = authorizationResponseProperties.map(key => Object.getOwnPropertyDescriptor(current, key)?.get)
      if (accessors.every(getter => typeof getter === "function")) {
        // Applying the intrinsic accessors proves the candidate carries the
        // response implementation's internal brand. Prototype metadata and
        // native-looking source text alone are forgeable.
        try {
          for (const getter of accessors) Reflect.apply(getter!, value, [])
          const localAccessors = authorizationResponseProperties.map(key => nativeResponseDescriptors[key]?.get)
          if (constructor === Response && accessors.some((getter, index) => getter !== localAccessors[index])) continue
          const foreignAccessors = authorizationResponseProperties.map(key => undiciResponseDescriptors?.[key]?.get)
          if (constructor === UndiciResponse && (!undiciResponseDescriptors || accessors.some((getter, index) => getter !== foreignAccessors[index]))) continue
          if (constructor === Response || constructor === UndiciResponse) {
            // A subclass may override response accessors while inheriting the
            // native prototype. Reject any such intermediate descriptor before
            // ordinary reads can expose attacker-controlled metadata.
            let intermediate = Object.getPrototypeOf(Object(value))
            while (intermediate && intermediate !== current) {
              if (authorizationResponseProperties.some(key => Object.prototype.hasOwnProperty.call(intermediate, key))) return false
              intermediate = Object.getPrototypeOf(intermediate)
            }
            return true
          }
        }
        catch {
          // Continue searching for a supported response prototype.
        }
      }
      current = Object.getPrototypeOf(current)
    }
    return false
  }
  catch {
    return false
  }
}

function getNativeAuthorizationBodyReader(body: unknown): ((this: object) => ReadableStreamDefaultReader<Uint8Array>) | false | undefined {
  if (body === null || typeof body !== "object") return
  try {
    const locked = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")?.get
    if (!locked || Reflect.apply(locked, body, [])) return false
    const ownReader = Object.getOwnPropertyDescriptor(body, "getReader")
    if (ownReader && ownReader.value !== ReadableStream.prototype.getReader) return false
    const reader = Reflect.apply(ReadableStream.prototype.getReader, body, [])
    const methods = getNativeAuthorizationReaderMethods(reader)
    if (!methods) return false
    Reflect.apply(methods.releaseLock, reader, [])
    const bodyUsed = Object.getOwnPropertyDescriptor(Response.prototype, "bodyUsed")?.get
    if (typeof bodyUsed !== "function" || bodyUsed.call(new Response(body as ReadableStream<Uint8Array>))) return false
    return ReadableStream.prototype.getReader
  }
  catch {
    return false
  }
}

function getNativeAuthorizationReaderMethods(reader: object) {
  const prototype = ReadableStreamDefaultReader.prototype
  const closed = Object.getOwnPropertyDescriptor(prototype, "closed")?.get
  const read = Object.getOwnPropertyDescriptor(prototype, "read")?.value
  const cancel = Object.getOwnPropertyDescriptor(prototype, "cancel")?.value
  const releaseLock = Object.getOwnPropertyDescriptor(prototype, "releaseLock")?.value
  if (typeof closed !== "function" || typeof read !== "function" || typeof cancel !== "function" || typeof releaseLock !== "function") return
  // Intrinsic methods perform the reader brand check and cannot be shadowed by the source object.
  Reflect.apply(closed, reader, [])
  return { read, cancel, releaseLock }
}

function isNativeUint8ArrayChunk(value: unknown): value is Uint8Array {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== "[object Uint8Array]") return false
  try {
    const byteLength = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "byteLength")?.get
    if (typeof byteLength !== "function") return false
    Reflect.apply(byteLength, value, [])
    return true
  }
  catch {
    return false
  }
}

function bridgeAuthorizationBody(
  body: ReadableStream<Uint8Array>,
  getReader: (this: object) => ReadableStreamDefaultReader<Uint8Array>,
) {
  // Use the already validated intrinsic method so shadowed stream properties cannot
  // dispatch caller-controlled code during authorization response normalization.
  const reader = Reflect.apply(getReader, body, [])
  const methods = getNativeAuthorizationReaderMethods(reader)
  if (!methods) throw new TypeError("Invalid ReadableStreamDefaultReader")
  const { read, cancel, releaseLock } = methods
  let released = false
  const release = () => {
    if (released) return
    released = true
    Reflect.apply(releaseLock, reader, [])
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await Reflect.apply(read, reader, []) as { done: boolean; value?: Uint8Array }
        if (result.done) {
          release()
          controller.close()
        }
        else {
          const chunk = result.value
          if (!isNativeUint8ArrayChunk(chunk)) throw new TypeError("Invalid authorization body chunk")
          controller.enqueue(chunk)
        }
      }
      catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await Reflect.apply(cancel, reader, [reason])
      }
      finally {
        release()
      }
    },
  }, { highWaterMark: 0 })
  return { stream, release }
}

async function normalizeAuthorizationResponse(value: unknown): Promise<Response | undefined> {
  if (value === null || Object(value) !== value) return
  try {
    const candidate = Object(value)
    if (!await hasResponsePrototype(candidate)) return
    // Own data properties can shadow native response fields on a spoof.
    if (authorizationResponseProperties.some(key => Object.prototype.hasOwnProperty.call(candidate, key))) return
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
    const nativeDescriptors = value instanceof Response && authorizationResponseProperties.every(key =>
      responsePropertyDescriptor(candidate, key)?.get === nativeResponseDescriptors[key]?.get)
    let nativeProperties = false
    let nativeBodyUnused = false
    try {
      nativeProperties = nativeDescriptors && authorizationResponseProperties.every(key => {
        const getter = nativeResponseDescriptors[key]?.get
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
    const nativeHeaderMethods = ["get", "forEach"].every(key =>
      responsePropertyDescriptor(headerCarrier, key)?.value === Object.getOwnPropertyDescriptor(Headers.prototype, key)?.value)
    // A foreign implementation must carry its own native Headers methods.
    // Accepting a foreign Response prototype paired with current-realm Headers
    // would make a user-defined Response-shaped object indistinguishable from
    // a genuine cross-runtime response.
    const cookieDescriptor = responsePropertyDescriptor(headerCarrier, "getSetCookie")
    const nativeCookieMethod = !cookieDescriptor?.get && (cookieDescriptor?.value === undefined
      || cookieDescriptor.value === Object.getOwnPropertyDescriptor(Headers.prototype, "getSetCookie")?.value)
    const nativeBodyReader = body === null ? true : getNativeAuthorizationBodyReader(body)
    if (value instanceof Response && nativeProperties && nativeHeaderMethods && nativeCookieMethod && nativeBodyReader) return value
    if (body !== null && typeof nativeBodyReader !== "function") return
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
    // A fallback Set-Cookie header cannot safely represent multiple cookies.
    // Reject any comma followed by a cookie assignment; this also covers boundaries
    // after Expires, Path, and extension attributes.
    if (combinedCookies !== undefined) {
      if (/,\s*[^;=,\s]+\s*=/.test(combinedCookies)) return
      normalizedHeaders.append("set-cookie", combinedCookies)
    }
    for (const cookie of cookies) normalizedHeaders.append("set-cookie", cookie)

    // Validate status and native body state before acquiring reader ownership.
    const normalizedResponse = status === 0 && statusText === "" && body === null && [...normalizedHeaders].length === 0
      ? Response.error()
      : new Response(body as ReadableStream<Uint8Array> | null, { status, statusText, headers: normalizedHeaders })
    if (body === null) return normalizedResponse
    if (typeof nativeBodyReader !== "function") return
    const bridgedBody = bridgeAuthorizationBody(body as ReadableStream<Uint8Array>, nativeBodyReader)
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
  }}

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
  if (authorize !== true && typeof authorize !== "function") {
    throw authErrorDiagnostics.AUTH_R0014({ message: "[vitehub] `authorize` must be true or a function." })
  }
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
    // Request URLs keep the application base path, so match each route below it.
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
