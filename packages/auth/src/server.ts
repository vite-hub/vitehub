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

/**
 * Only `true` grants access. A Response of this runtime is sent as the rejection. Every other value gets `403`.
 */
async function runAccessAuthorize(
  authorize: AuthAccessAuthorize,
  context: AuthAccessAuthorizationContext,
): Promise<Response | undefined> {
  const result: unknown = await authorize(context)
  if (result === true) return
  const response = await normalizeAuthorizationResponse(result)
  return response ?? createForbiddenResponse(context.request)
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
  catch {
    return false
  }
}

function isSerializableAuthorizationBody(body: unknown): body is ReadableStream<Uint8Array> | null {
  if (body === null) return true
  if (Object(body) !== body) return false

  const stream = body as object
  try {
    // Response performs the platform ReadableStream brand check without
    // consulting getReader, read, cancel, releaseLock, or closed properties.
    // Identity distinguishes a genuine stream from a generic body value.
    if (!hasNativeStreamBrand(stream)) return false
    if (stream instanceof ReadableStream) {
      const locked = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")?.get
      if (locked && Reflect.apply(locked, stream, []) !== false) return false
    }
    return true
  }
  catch {
    return false
  }
}


function hasNativeStreamBrand(body: object): boolean {
  try {
    // A stream's reader acquisition is an internal capability. An own
    // property shadows the native operation and must fail closed; native
    // tee() can otherwise accept the stream without ever exercising it.
    if (Object.prototype.hasOwnProperty.call(body, "getReader")) return false
    // Response's BodyInit conversion performs the platform ReadableStream brand
    // check, including for streams created in another realm. A spoofed object is
    // converted to a new stream, so identity distinguishes it from a real stream.
    return new Response(body as ReadableStream).body === body
  }
  catch {
    return false
  }
}

async function normalizeAuthorizationResponse(value: unknown): Promise<Response | undefined> {
  if (value === null || Object(value) !== value) return
  try {
    const candidate = Object(value)
    if (!await hasResponsePrototype(candidate)) return
    // Validate local responses through their native accessors before reading
    // any proxy-trapped properties. Proxies cannot satisfy Response's
    // internal-slot checks, so reject them without trusting their snapshots.
    const localResponse = (() => {
      try {
        const getter = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get
        if (!getter) return false
        Reflect.apply(getter, candidate, [])
        return true
      }
      catch {
        return false
      }
    })()
    // A proxy around a local Response still passes `instanceof Response`, but
    // native accessors reject the proxy. Reject that path before trusting any
    // proxy-trapped fields in the foreign-response normalization below.
    const localProxy = !localResponse && value instanceof Response
    if (localResponse) {
      try {
        const nativeStatus = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get
        const nativeStatusText = Object.getOwnPropertyDescriptor(Response.prototype, "statusText")?.get
        const nativeHeaders = Object.getOwnPropertyDescriptor(Response.prototype, "headers")?.get
        const nativeBody = Object.getOwnPropertyDescriptor(Response.prototype, "body")?.get
        const nativeBodyUsed = Object.getOwnPropertyDescriptor(Response.prototype, "bodyUsed")?.get
        if (!nativeStatus || !nativeStatusText || !nativeHeaders || !nativeBody || !nativeBodyUsed) return
        // Validate the internal slots directly. This also accepts legitimate
        // Response subclasses that override accessors while rejecting proxies,
        // whose native accessors fail the brand check.
        Reflect.apply(nativeStatus, candidate, [])
        Reflect.apply(nativeStatusText, candidate, [])
        Reflect.apply(nativeHeaders, candidate, [])
        Reflect.apply(nativeBody, candidate, [])
        if (Reflect.apply(nativeBodyUsed, candidate, [])) return
        const nativeBodyValue = Reflect.apply(nativeBody, candidate, [])
        if (nativeBodyValue !== null) {
          const locked = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")?.get
          if (locked && Reflect.apply(locked, nativeBodyValue, [])) return
        }
        return candidate as Response
      }
      catch {
        return
      }
    }
    // Snapshot foreign responses only when their native accessors agree with
    // the exposed values. This rejects proxies that shadow response fields.
    const nativeField = (key: PropertyKey, exposed: unknown) => {
      const descriptor = responsePropertyDescriptor(candidate, key)
      if (!descriptor?.get) return false
      try {
        return Object.is(Reflect.apply(descriptor.get, candidate, []), exposed)
      }
      catch {
        return false
      }
    }
    const status: unknown = Reflect.get(candidate, "status")
    const statusText: unknown = Reflect.get(candidate, "statusText")
    const headers: unknown = Reflect.get(candidate, "headers")
    const body: unknown = Reflect.get(candidate, "body")
    const bodyUsed: unknown = Reflect.get(candidate, "bodyUsed")
    if (!localProxy && (!nativeField("status", status) || !nativeField("statusText", statusText)
      || !nativeField("headers", headers) || !nativeField("body", body)
      || !nativeField("bodyUsed", bodyUsed))) return
    if (bodyUsed !== false) return
    if (typeof status !== "number" || !Number.isInteger(status)
      || (status !== 0 && (status < 200 || status > 599))) return
    if (typeof statusText !== "string") return
    if (headers === null || Object(headers) !== headers) return
    // Response construction rejects bodies for these status codes. Check this
    // before transferring a foreign stream so a rejected candidate retains
    // ownership of its original body.
    if (body !== null && (status === 204 || status === 205 || status === 304)) return

    const headerCarrier = Object(headers)
    // Local Response values were returned above after native slot validation;
    // an instanceof value that failed that validation is a proxy or malformed wrapper.
    // A proxy around a local Response cannot pass native accessors directly,
    // but its ordinary reads still provide a stable snapshot for normalization.

    const headerPrototype = Object.getPrototypeOf(headerCarrier)
    const headerMethodOwners = ["get", "forEach"].map(key => {
      if (!headerPrototype || Object.prototype.hasOwnProperty.call(headerCarrier, key)) return undefined
      const descriptor = Object.getOwnPropertyDescriptor(headerPrototype, key)
      if (!descriptor || typeof descriptor.value !== "function") return undefined
      // Native Headers prototypes inherit directly from their runtime's Object
      // prototype. An inserted prototype layer would inherit from the native
      // Headers prototype and could replace the methods we are about to invoke.
      const parent = Object.getPrototypeOf(headerPrototype)
      if (parent && (Object.prototype.hasOwnProperty.call(parent, key)
        || Object.prototype.hasOwnProperty.call(parent, key === "get" ? "forEach" : "get"))) return undefined
      return headerPrototype
    })
    const nativeHeaderMethods = headerMethodOwners.every(Boolean)
      && headerMethodOwners[0] === headerMethodOwners[1]
    // A foreign implementation must carry its own native Headers methods.
    // Accepting a foreign Response prototype paired with current-realm Headers
    // would make a user-defined Response-shaped object indistinguishable from
    // a genuine cross-runtime response.
    // Only invoke the known undici implementation. Other runtimes use the
    // validated forEach fallback, so caller-installed cookie methods stay out
    // of the authorization boundary.
    if (!nativeHeaderMethods) return
    if (body !== null && !isSerializableAuthorizationBody(body)) return
    const forEach = Reflect.get(headerCarrier, "forEach")
    const normalizedHeaders = new Headers()
    const cookieValues: string[] = []
    Reflect.apply(forEach, headers, [(value: string, key: string) => {
      if (key.toLowerCase() === "set-cookie") {
        cookieValues.push(value)
        return
      }
      normalizedHeaders.append(key, value)
    }])
    // Preserve cookies exposed by the validated enumeration method. Some foreign
    // Headers implementations combine duplicate Set-Cookie fields into one value;
    // split only at commas that begin another cookie-pair, leaving commas in
    // Expires attributes untouched.
    for (const cookie of cookieValues) {
      const parts: string[] = []
      let start = 0
      const boundary = /,[\s]*(?=[^;,=\s]+\s*=)/g
      for (const match of cookie.matchAll(boundary)) {
        const index = match.index
        parts.push(cookie.slice(start, index))
        start = index + match[0].length
      }
      parts.push(cookie.slice(start))
      for (const part of parts) normalizedHeaders.append("set-cookie", part)
    }
    const normalizedResponse = status === 0 && statusText === "" && body === null && [...normalizedHeaders].length === 0
      ? Response.error()
      : new Response(body, { status, statusText, headers: normalizedHeaders })
    return normalizedResponse
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
