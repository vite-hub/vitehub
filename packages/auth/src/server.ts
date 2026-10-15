import discoveredDefinition from "#vitehub/auth/definition"
import { betterAuth } from "better-auth"
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
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The build injects this value only when `vitehub({ publicUrl })` is set.
  return typeof __VITEHUB_PUBLIC_URL__ !== "undefined"
    && Boolean(__VITEHUB_PUBLIC_URL__?.url || Object.keys(__VITEHUB_PUBLIC_URL__?.agents ?? {}).length)
}

let authRuntimeEnvResolver: AuthRuntimeEnvResolver | undefined

export function setAuthRuntimeEnvResolver(resolver: AuthRuntimeEnvResolver | undefined): void {
  authRuntimeEnvResolver = resolver
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
  return resolveAuthOptions(definition, { request, runtimeOptions, event, env: authRuntimeEnvResolver }).requestRuntimeOptions
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
  return resolveAuthOptions(definition, { runtimeOptions, env: authRuntimeEnvResolver }).providerOptions
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
  return betterAuth(resolveAuthOptions(definition, { request, runtimeOptions, event, env: authRuntimeEnvResolver }).providerOptions) as ViteHubAuth
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
  return createAuthenticationProvider(resolveAuthOptions(definition, { request, runtimeOptions, event, env: authRuntimeEnvResolver }).providerOptions)
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
  const basePath = normalizeAuthBasePath(typeof options.basePath === "string" ? options.basePath : undefined)
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
  const { options, providerOptions } = resolveAuthOptions(definition, { request, event: input, env: authRuntimeEnvResolver })
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

async function runAccessAuthorize(
  authorize: AuthAccessAuthorize,
  context: AuthAccessAuthorizationContext,
): Promise<Response | undefined> {
  const result = await authorize(context)
  const response = normalizeAuthorizationResponse(result)
  if (response) return response
  if (result !== true) return createForbiddenResponse(context.request)
}

const authorizationResponseProperties = ["status", "statusText", "headers", "body"] as const

const authorizationResponsePrototypeLimit = 32

const nativeReaderMethods = Object.fromEntries(([
  "read", "cancel", "releaseLock",
] as const).map(key => [key, Object.getOwnPropertyDescriptor(ReadableStreamDefaultReader.prototype, key)?.value])) as Record<string, unknown>
const functionToString = Function.prototype.toString
const nativeReaderMethodSources = Object.fromEntries(Object.entries(nativeReaderMethods).map(([key, value]) => [
  key,
  typeof value === "function" ? functionToString.call(value) : undefined,
])) as Record<string, string | undefined>
const nativeStreamGetReader = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "getReader")?.value
const nativeStreamGetReaderSource = typeof nativeStreamGetReader === "function"
  ? functionToString.call(nativeStreamGetReader)
  : undefined
function isNativeReaderMethod(value: unknown, key: string): value is (...args: unknown[]) => unknown {
  if (value === nativeReaderMethods[key]) return true
  if (typeof value !== "function") return false
  try { return functionToString.call(value) === nativeReaderMethodSources[key] }
  catch { return false }
}

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

function hasResponsePrototype(value: unknown): boolean {
  try {
    let prototype: object | null = Object.getPrototypeOf(Object(value))
    const seen = new Set<object>()
    for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (seen.has(prototype)) return false
      seen.add(prototype)
      const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
      const owner = prototype
      if (constructor?.name === "Response"
        && authorizationResponseProperties.every(key => Object.getOwnPropertyDescriptor(owner, key)?.get)) return true
      prototype = Object.getPrototypeOf(prototype)
    }
  }
  catch {
    return false
  }
  return false
}


function isSerializableAuthorizationBody(
  body: unknown,
  nativeReader: ((this: object) => ReadableStreamDefaultReader<Uint8Array>) | undefined,
): body is ReadableStream<Uint8Array> | null {
  if (body === null) return true
  if (typeof body !== "object" || !nativeReader) return false
  try {
    // Re-check the descriptor before bridging. This keeps the verified native
    // operation tied to the stream shape and fails closed if a caller adds an
    // own or intermediate reader override between inspection and invocation.
    if (Object.prototype.hasOwnProperty.call(body, "getReader")) return false
    let prototype: object | null = Object.getPrototypeOf(body)
    const seen = new Set<object>()
    let readerVerified = false
    for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (seen.has(prototype)) return false
      seen.add(prototype)
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "getReader")
      if (descriptor) {
        readerVerified = "value" in descriptor && descriptor.value === nativeReader
        break
      }
      prototype = Object.getPrototypeOf(prototype)
    }
    if (!readerVerified) return false
    const locked = Reflect.get(body, "locked")
    return locked === false
  }
  catch {
    return false
  }
}

function hasNativeAuthorizationReaderPrototype(reader: object): boolean {
  try {
    const methods = ["read", "cancel", "releaseLock"] as const
    let prototype: object | null = Object.getPrototypeOf(reader)
    const seen = new Set<object>()
    for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (seen.has(prototype)) return false
      seen.add(prototype)
      const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
      if (constructor?.name !== "ReadableStreamDefaultReader") {
        prototype = Object.getPrototypeOf(prototype)
        continue
      }
      for (const key of methods) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
        if (!descriptor || !isNativeReaderMethod(descriptor.value, key)) return false
        let parent = Object.getPrototypeOf(prototype)
        for (let parentDepth = 0; parent && parentDepth < authorizationResponsePrototypeLimit; parentDepth++) {
          if (Object.getOwnPropertyDescriptor(parent, key)) return false
          parent = Object.getPrototypeOf(parent)
        }
      }
      return true
    }
  }
  catch { /* malformed reader prototypes fail closed */ }
  return false
}


function getNativeAuthorizationBodyReader(body: unknown): ((this: object) => ReadableStreamDefaultReader<Uint8Array>) | undefined {
  if (body === null || typeof body !== "object") return
  try {
    // An own reader (or a reader supplied by an intermediate prototype) is
    // caller-controlled. Resolve the first descriptor without invoking it,
    // and accept only a native ReadableStream prototype method. The
    // constructor-name check is realm-independent, unlike comparing against
    // this realm's ReadableStream.prototype.
    if (Object.prototype.hasOwnProperty.call(body, "getReader")) return
    let prototype: object | null = Object.getPrototypeOf(body)
    const seen = new Set<object>()
    for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (seen.has(prototype)) return
      seen.add(prototype)
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "getReader")
      if (descriptor) {
        const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
        // A name-only constructor is easy to spoof and does not establish a
        // native stream brand. Genuine stream prototypes own this link.
        if (typeof constructor !== "function" || constructor.prototype !== prototype) return
        const locked = Object.getOwnPropertyDescriptor(prototype, "locked")
        const nativeShape = locked?.get
          && Object.getOwnPropertyDescriptor(prototype, "cancel")?.value
          && Object.getOwnPropertyDescriptor(prototype, "tee")?.value
          && Object.getOwnPropertyDescriptor(prototype, "pipeTo")?.value
          && Object.getOwnPropertyDescriptor(prototype, "pipeThrough")?.value
        if (typeof nativeShape !== "function") return
        // A reader on an intermediate prototype can shadow the stream
        // implementation. Genuine stream prototypes have no second reader
        // further up their chain, so reject shadowed methods before invoking.
        let parent = Object.getPrototypeOf(prototype)
        for (let parentDepth = 0; parent && parentDepth < authorizationResponsePrototypeLimit; parentDepth++) {
          if (Object.getOwnPropertyDescriptor(parent, "getReader")) return
          parent = Object.getPrototypeOf(parent)
        }
        if (typeof descriptor.value === "function"
          && constructor?.name === "ReadableStream"
          // Cross-realm native methods share the platform's native source
          // representation. Reject lookalike functions before probing them,
          // since probing invokes the candidate operation.
          && nativeStreamGetReaderSource !== undefined
          && functionToString.call(descriptor.value) === nativeStreamGetReaderSource) {
          // Probe the source runtime's reader prototype before acquiring the
          // caller's body lock. This lets malformed foreign readers fail
          // closed without relying on a host-realm releaseLock operation.
          const probeStream = Reflect.construct(constructor, [{}])
          const probeReader = Reflect.apply(descriptor.value, probeStream, []) as object
          if (!hasNativeAuthorizationReaderPrototype(probeReader)) return
          const probeRelease = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(probeReader), "releaseLock")?.value
          if (typeof probeRelease !== "function") return
          Reflect.apply(probeRelease, probeReader, [])
          // A spoofed method can imitate the native source text while doing
          // nothing. Verify the intrinsic operation actually releases the
          // probe lock before allowing a source reader to be acquired.
          if (probeStream.locked) return
          return descriptor.value
        }
        return
      }
      prototype = Object.getPrototypeOf(prototype)
    }
  }
  catch {
    return
  }
}

function bridgeAuthorizationBody(body: ReadableStream<Uint8Array>, getReader: (this: object) => ReadableStreamDefaultReader<Uint8Array>) {
  // Invoke the source stream's native operations so separate realms retain their brand.
  const reader = Reflect.apply(getReader, body, [])
  const nativeReaderMethod = (key: "read" | "cancel" | "releaseLock") => {
    if (Object.prototype.hasOwnProperty.call(reader, key)) throw new Error("Malformed authorization response reader")
    let prototype: object | null = Object.getPrototypeOf(reader)
    const seen = new Set<object>()
    for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (seen.has(prototype)) throw new Error("Malformed authorization response reader")
      seen.add(prototype)
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
      if (descriptor) {
        const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
        if (!isNativeReaderMethod(descriptor.value, key) || constructor?.name !== "ReadableStreamDefaultReader") {
          throw new Error("Malformed authorization response reader")
        }
        let parent = Object.getPrototypeOf(prototype)
        for (let parentDepth = 0; parent && parentDepth < authorizationResponsePrototypeLimit; parentDepth++) {
          if (Object.getOwnPropertyDescriptor(parent, key)) throw new Error("Malformed authorization response reader")
          parent = Object.getPrototypeOf(parent)
        }
        return descriptor.value as (...args: unknown[]) => unknown
      }
      prototype = Object.getPrototypeOf(prototype)
    }
    throw new Error("Malformed authorization response reader")
  }
  let read: ReadableStreamDefaultReader<Uint8Array>["read"]
  let cancel: ReadableStreamDefaultReader<Uint8Array>["cancel"]
  let releaseLock: ReadableStreamDefaultReader<Uint8Array>["releaseLock"]
  // Capture the source realm's release operation before validating the other
  // methods. The host intrinsic cannot release a reader branded by a foreign
  // runtime, so cleanup must use that reader's own native method.
  let sourceReleaseLock: ((this: object) => unknown) | undefined
  try {
    let prototype: object | null = Object.getPrototypeOf(reader)
    const seen = new Set<object>()
    for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (seen.has(prototype)) break
      seen.add(prototype)
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "releaseLock")
      if (descriptor) {
        if (typeof descriptor.value === "function" && isNativeReaderMethod(descriptor.value, "releaseLock")) {
          sourceReleaseLock = descriptor.value as (this: object) => unknown
        }
        break
      }
      prototype = Object.getPrototypeOf(prototype)
    }
  }
  catch { /* validation below reports malformed readers */ }
  try {
    read = nativeReaderMethod("read") as ReadableStreamDefaultReader<Uint8Array>["read"]
    cancel = nativeReaderMethod("cancel") as ReadableStreamDefaultReader<Uint8Array>["cancel"]
    releaseLock = nativeReaderMethod("releaseLock") as ReadableStreamDefaultReader<Uint8Array>["releaseLock"]
  }
  catch (error) {
    // Validation happens after getReader acquires the source lock. Always try
    // the captured intrinsic so malformed readers cannot leave that lock held.
    try {
      const release = sourceReleaseLock ?? nativeReaderMethods.releaseLock as (...args: unknown[]) => unknown
      Reflect.apply(release, reader, [])
    }
    catch { /* preserve the original validation failure */ }
    throw error
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    Reflect.apply(releaseLock, reader, [])
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await Reflect.apply(read, reader, [])
        if (result.done) {
          release()
          controller.close()
        }
        else controller.enqueue(result.value)
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

function normalizeAuthorizationResponse(value: unknown): Response | undefined {
  if (value === null || Object(value) !== value) return
  try {
    const candidate = Object(value)
    if (!hasResponsePrototype(candidate)) return
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
      responsePropertyDescriptor(candidate, key)?.get === Object.getOwnPropertyDescriptor(Response.prototype, key)?.get)
    let nativeProperties = false
    try {
      nativeProperties = nativeDescriptors && authorizationResponseProperties.every(key => {
        const getter = Object.getOwnPropertyDescriptor(Response.prototype, key)?.get
        return getter && Reflect.apply(getter, candidate, []) === snapshot[key]
      })
    }
    catch {
      // A proxy can expose native descriptors without owning native response state.
    }
    const nativeHeaderMethods = ["get", "forEach"].every(key =>
      responsePropertyDescriptor(headerCarrier, key)?.value === Object.getOwnPropertyDescriptor(Headers.prototype, key)?.value)
    const cookieDescriptor = responsePropertyDescriptor(headerCarrier, "getSetCookie")
    const nativeCookieMethod = !cookieDescriptor?.get && (cookieDescriptor?.value === undefined
      || cookieDescriptor.value === Object.getOwnPropertyDescriptor(Headers.prototype, "getSetCookie")?.value)

    const nativeBodyReader = body === null
      ? (() => { throw new Error("A null body has no reader") })
      : getNativeAuthorizationBodyReader(body)
    if (value instanceof Response && nativeProperties && nativeHeaderMethods && nativeCookieMethod && nativeBodyReader) return value
    if (!nativeBodyReader || !isSerializableAuthorizationBody(body, nativeBodyReader)) return
    const forEach = Reflect.get(headerCarrier, "forEach")
    const getSetCookie = Reflect.get(headerCarrier, "getSetCookie")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Headers.getSetCookie is optional across runtimes; capture its result once when callable.
    const cookies: unknown = typeof getSetCookie === "function" ? Reflect.apply(getSetCookie, headers, []) : []
    if (!Array.isArray(cookies)) return
    const normalizedHeaders = new Headers()
    Reflect.apply(forEach, headers, [(value: string, key: string) => {
      if (key.toLowerCase() !== "set-cookie" || cookies.length === 0) normalizedHeaders.append(key, value)
    }])
    for (const cookie of cookies) normalizedHeaders.append("set-cookie", cookie)


    // Validate status and native body state before acquiring reader ownership.
    const normalizedResponse = status === 0 && statusText === "" && body === null && [...normalizedHeaders].length === 0
      ? Response.error()
      : new Response(body, { status, statusText, headers: normalizedHeaders })
    if (body === null) return normalizedResponse
    const bridgedBody = bridgeAuthorizationBody(body, nativeBodyReader)
    try {
      return new Response(bridgedBody.stream, { status, statusText, headers: normalizedHeaders })
    }
    catch (error) {
      bridgedBody.release()
      throw error
    }
  }
  catch {
    return undefined
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
      const authorize = route instanceof Object ? route.authorize : undefined
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
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The public authorization boundary accepts callable callbacks from any JavaScript realm.
  if (authorize !== true && typeof authorize !== "function") {
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
    path: route.route.endsWith("/**") ? route.route.slice(0, -3) : route.route,
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
