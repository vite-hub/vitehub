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
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The build injects this value only when `vitehub({ publicUrl })` is set.
  return typeof __VITEHUB_PUBLIC_URL__ !== "undefined"
    && Boolean(__VITEHUB_PUBLIC_URL__?.url || Object.keys(__VITEHUB_PUBLIC_URL__?.agents ?? {}).length)
}

let authRuntimeEnvResolver: AuthRuntimeEnvResolver | undefined = getAuthRuntimeState().envResolver

export function setAuthRuntimeEnvResolver(resolver: AuthRuntimeEnvResolver | undefined): void {
  authRuntimeEnvResolver = resolver
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
}

async function runAccessAuthorize(
  authorize: AuthAccessAuthorize,
  context: AuthAccessAuthorizationContext,
): Promise<Response | undefined> {
  const result = await authorize(context)
  if (result === true) return
  const response = await normalizeAuthorizationResponse(result)
  if (response) return response
  return createForbiddenResponse(context.request)
}


const authorizationResponseProperties = ["status", "statusText", "headers", "body"] as const

const authorizationResponsePrototypeLimit = 32
const nativeStreamPrototype = ReadableStream.prototype
const nativeReaderPrototype = Object.getPrototypeOf(new ReadableStream().getReader())
const nativeStreamLocked = Object.getOwnPropertyDescriptor(nativeStreamPrototype, "locked")?.get
const nativeStreamGetReader = Object.getOwnPropertyDescriptor(nativeStreamPrototype, "getReader")?.value
const nativeReaderRead = Object.getOwnPropertyDescriptor(nativeReaderPrototype, "read")?.value
const nativeReaderCancel = Object.getOwnPropertyDescriptor(nativeReaderPrototype, "cancel")?.value
const nativeReaderReleaseLock = Object.getOwnPropertyDescriptor(nativeReaderPrototype, "releaseLock")?.value

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

async function responseImplementation(value: unknown): Promise<typeof Response | undefined> {
  const implementations = [Response]
  const UndiciResponse = await getUndiciResponse()
  if (UndiciResponse && UndiciResponse !== Response) implementations.push(UndiciResponse)
  try {
    let current = Object.getPrototypeOf(Object(value))
    const seen = new Set<object>()
    for (let depth = 0; current && depth < authorizationResponsePrototypeLimit; depth++) {
      const implementation = implementations.find(candidate => candidate.prototype === current)
      if (implementation) return implementation
      if (seen.has(current)) return
      seen.add(current)
      current = Object.getPrototypeOf(current)
    }
    return
  }
  catch {
    return
  }
}

function streamIntrinsic<T extends PropertyKey>(body: object, key: T): { value: unknown, owner: object } | undefined {
  let current: object | null = body
  const seen = new Set<object>()
  for (let depth = 0; current && depth < authorizationResponsePrototypeLimit; depth++) {
    if (seen.has(current)) return
    seen.add(current)
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) return { value: descriptor.get ?? descriptor.value, owner: current }
    current = Object.getPrototypeOf(current)
  }
}

function isNativeFunction(value: unknown, localIntrinsic?: unknown, expectedName?: string, allowPrototype = false, requireNativeSource = true): value is (...args: never[]) => unknown {
  if (typeof value !== "function") return false
  if (value === localIntrinsic) return true
  try {
    // Web platform operations are prototype methods (including accessors),
    // never ordinary function declarations with their own prototype object.
    // Reject those declarations before their body can be invoked. This also
    // excludes the common forged `function namedLikeAnIntrinsic() {}` shape.
    if (!allowPrototype && Object.getOwnPropertyDescriptor(value, "prototype")) return false
    if (expectedName && value.name !== expectedName) return false
    // Cross-realm Web API operations are still native functions. Requiring the
    // native source marker rejects caller-defined arrows and ordinary methods
    // that merely spoof an intrinsic name before they can be invoked.
    const source = Function.prototype.toString.call(value)
    if (requireNativeSource) return source.includes("[native code]")
    // Function#toString intentionally exposes callable proxies as an
    // anonymous native function. Genuine Web API operations retain their
    // operation name, so reject this proxy form before invocation.
    if (source === "function () { [native code] }") return false
    // Cross-runtime implementations may be ordinary functions, but caller
    // supplied arrows and concise methods have distinctive source forms. Keep
    // those out of the normalization boundary before they can be invoked.
    if (source.includes("=>")) return false
    // Async functions are executable caller code even when they spoof an
    // intrinsic operation name and otherwise resemble a native method.
    if (/^\s*async\s+function\b/.test(source)) return false
    // Async concise methods have the same caller-controlled body but stringify
    // as `async name() { ... }`, so reject them before invocation as well.
    if (/^\s*async\s+[^\s(]+\s*\([^)]*\)\s*\{/.test(source)) return false
    // Concise methods are always created by the response author. Unlike
    // cross-runtime implementations, which expose function declarations or
    // native source, these methods can be padded with arbitrary executable
    // code while retaining an intrinsic-looking name.
    if (/^\s*(?:get\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/.test(source)) return false
    // Computed concise methods stringify with a bracketed property key but are
    // still caller-defined executable methods.
    if (/^\s*(?:get\s+)?\[[\s\S]*\]\s*\([^)]*\)\s*\{/.test(source)) return false
    return true
  }
  catch {
    return false
  }
}

function readerOperation(readerPrototype: object, key: "read" | "cancel" | "releaseLock"): unknown {
  // Reader operations must be owned by the verified native prototype. Never
  // walk the reader or its prototype chain after the source-realm check.
  return Object.getOwnPropertyDescriptor(readerPrototype, key)?.value
}

function isSerializableAuthorizationBody(body: unknown): body is ReadableStream<Uint8Array> | null {
  if (body === null) return true
  if (Object(body) !== body) return false
  const stream = body as object
  // An own reader operation belongs to the caller-controlled body object.
  // Inherited stream methods are resolved from the source realm below.
  if (Object.prototype.hasOwnProperty.call(stream, "locked")
    || Object.prototype.hasOwnProperty.call(stream, "getReader")) return false
  const locked = streamIntrinsic(stream, "locked")
  const getReader = locked && streamIntrinsic(locked.owner, "getReader")
  if (!locked || !getReader || locked.owner !== getReader.owner
    || !isNativeFunction(locked.value, nativeStreamLocked, "locked", false, false) || !isNativeFunction(getReader.value, nativeStreamGetReader, "getReader", false, false)) return false
  if (Reflect.apply(locked.value, stream, [])) return false
  // The Web Streams API exposes the disturbed state only through brand checks:
  // constructing a Response rejects a stream that has already been consumed,
  // even after its reader has released the lock. Keep this probe before the
  // bridge acquires ownership so response-shaped values cannot silently turn
  // into empty bodies.
  try {
    new Response(stream as ReadableStream<Uint8Array>)
    return true
  }
  catch {
    return false
  }
}

function authorizationHeaderMethods(headers: object): { forEach: (...args: never[]) => unknown, getSetCookie?: (...args: never[]) => unknown } | undefined {
  // Header methods perform a realm-specific brand check. Capture the methods
  // from this carrier's verified native prototype and invoke them on the carrier.
  const findMethod = (key: string) => {
    let owner: object | null = Object(headers)
    const seen = new Set<object>()
    for (let depth = 0; owner && depth < authorizationResponsePrototypeLimit; depth++) {
      if (seen.has(owner)) return
      seen.add(owner)
      const descriptor = Object.getOwnPropertyDescriptor(owner, key)
      if (descriptor) return { owner, value: descriptor.value }
      owner = Object.getPrototypeOf(owner)
    }
  }
  const forEachEntry = findMethod("forEach")
  const cookieEntry = findMethod("getSetCookie")
  if (!forEachEntry || !isNativeFunction(forEachEntry.value, Object.getOwnPropertyDescriptor(Headers.prototype, "forEach")?.value, "forEach", false, false)) return
  // An own accessor is supplied by the response carrier and cannot be
  // authenticated as the runtime's intrinsic without invoking it. Fail closed
  // before executing caller-controlled code; supported runtimes expose the
  // accessor on their native Headers prototype.
  if (cookieEntry && cookieEntry.value !== undefined && (cookieEntry.owner === headers
    || !isNativeFunction(cookieEntry.value, Object.getOwnPropertyDescriptor(Headers.prototype, "getSetCookie")?.value, "getSetCookie", false, false))) return
  // Some supported runtimes expose getSetCookie as an instance-level wrapper
  // while forEach remains on the Headers prototype. Validate each callable
  // independently and allow those carrier-owned accessors.
  const owner = forEachEntry.owner
  const constructor = Object.getOwnPropertyDescriptor(owner, "constructor")?.value
  const tag = Object.getOwnPropertyDescriptor(owner, Symbol.toStringTag)?.value
  if (owner === headers || typeof constructor !== "function" || constructor.name !== "Headers" || constructor.prototype !== owner || tag !== "Headers") return
  const forEach = forEachEntry.value
  const getSetCookie = cookieEntry?.value
  return { forEach: forEach as (...args: never[]) => unknown, getSetCookie: getSetCookie as (...args: never[]) => unknown | undefined }
}

function bridgeAuthorizationBody(body: ReadableStream<Uint8Array>) {
  // Use native operations from the stream's realm, never caller-supplied methods.
  const locked = streamIntrinsic(body, "locked")
  const getReaderIntrinsic = locked && streamIntrinsic(locked.owner, "getReader")
  if (!locked || !getReaderIntrinsic || locked.owner !== getReaderIntrinsic.owner
    || !isNativeFunction(locked.value, nativeStreamLocked, "locked", false, false)
    || !isNativeFunction(getReaderIntrinsic.value, nativeStreamGetReader, "getReader", false, false)) throw new Error("Non-native response stream")
  const streamPrototype = locked.owner
  const streamConstructor = Object.getOwnPropertyDescriptor(streamPrototype, "constructor")?.value
  // The constructor is metadata only. Never call or construct a value supplied by the response.
  if (!isNativeFunction(streamConstructor, ReadableStream, "ReadableStream", true, false) || streamConstructor.name !== "ReadableStream"
    || streamConstructor.prototype !== streamPrototype) throw new Error("Non-native response stream")
  const getReader = getReaderIntrinsic.value as (this: ReadableStream<Uint8Array>) => ReadableStreamDefaultReader<Uint8Array>
  let readerPromise: Promise<{
    reader: ReadableStreamDefaultReader<Uint8Array>
    read: (this: ReadableStreamDefaultReader<Uint8Array>) => Promise<{ done: true, value?: undefined } | { done: false, value: Uint8Array }>
    cancel: (this: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown) => Promise<void>
    release: (this: ReadableStreamDefaultReader<Uint8Array>) => void
  }> | undefined
  const acquireReader = async () => {
    if (readerPromise) return readerPromise
    readerPromise = (async () => {
      const reader = Reflect.apply(getReader, body, [])
      const acquiredReleaseLock = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(reader) ?? {}, "releaseLock")?.value
      try {
    const readerPrototype = Object.getPrototypeOf(reader)
    if (!readerPrototype || Object.prototype.hasOwnProperty.call(reader, "read")
      || Object.prototype.hasOwnProperty.call(reader, "cancel")
      || Object.prototype.hasOwnProperty.call(reader, "releaseLock")) throw new Error("Non-native response reader")
    const readerConstructor = Object.getOwnPropertyDescriptor(readerPrototype, "constructor")?.value
    if (!isNativeFunction(readerConstructor, nativeReaderPrototype.constructor, "ReadableStreamDefaultReader", true, false)
      || readerConstructor.name !== "ReadableStreamDefaultReader"
      || readerConstructor.prototype !== readerPrototype) throw new Error("Non-native response reader")
    // The returned reader may have a caller-controlled immediate prototype. Its
    // constructor identity and native operations are checked before invocation.
    // The first reader acquisition locks the source stream. Inspect this reader's
    // prototype directly instead of acquiring a second reader while it is locked.
    const read = readerOperation(readerPrototype, "read") as ((this: ReadableStreamDefaultReader<Uint8Array>) => Promise<{ done: true, value?: undefined } | { done: false, value: Uint8Array }>) | undefined
    const cancel = readerOperation(readerPrototype, "cancel") as ((this: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown) => Promise<void>) | undefined
    const releaseLock = readerOperation(readerPrototype, "releaseLock") as ((this: ReadableStreamDefaultReader<Uint8Array>) => void) | undefined
    // Native reader operations have stable names across realms. This rejects
    // replacements installed on a shared reader prototype before any
    // caller-controlled operation is invoked.
    if (!isNativeFunction(read, nativeReaderRead, "read", false, false) || read.name !== "read"
    || !isNativeFunction(cancel, nativeReaderCancel, "cancel", false, false) || cancel.name !== "cancel"
    || !isNativeFunction(releaseLock, nativeReaderReleaseLock, "releaseLock", false, false) || releaseLock.name !== "releaseLock") throw new Error("Non-native response reader")
        return { reader, read, cancel, release: releaseLock }
      }
      catch (error) {
        try { if (typeof acquiredReleaseLock === "function") Reflect.apply(acquiredReleaseLock, reader, []) } catch { /* best effort */ }
        throw error
      }
    })()
    return readerPromise
  }
  let released = false
  const release = async () => {
    if (released) return
    released = true
    if (!readerPromise) return
    const acquired = await readerPromise
    Reflect.apply(acquired.release, acquired.reader, [])
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { reader, read } = await acquireReader()
        const result = await Reflect.apply(read, reader, [])
        if (result.done) {
          await release()
          controller.close()
        }
        else if (!isIntrinsicUint8Array(result.value)) {
          await release()
          controller.error(new Error("Malformed authorization read result"))
        }
        else controller.enqueue(result.value)
      }
      catch (error) {
        try { await release() } catch { /* best effort */ }
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        const { reader, cancel } = await acquireReader()
        await Reflect.apply(cancel, reader, [reason])
      }
      finally {
        try { await release() } catch { /* best effort */ }
      }
    },
  }, { highWaterMark: 0 })
  return { stream, release }
}

async function normalizeAuthorizationResponse(value: unknown): Promise<Response | undefined> {
  if (value === null || Object(value) !== value) return
  try {
    const candidate = Object(value)
    const responseImplementationConstructor = await responseImplementation(candidate)
    if (!responseImplementationConstructor) return
    // Snapshot ordinary property reads once. Prototype shape is not proof of origin.
    const status: unknown = Reflect.get(candidate, "status")
    const statusText: unknown = Reflect.get(candidate, "statusText")
    const headers: unknown = Reflect.get(candidate, "headers")
    const body: unknown = Reflect.get(candidate, "body")
    const bodyUsed: unknown = Reflect.get(candidate, "bodyUsed")
    const type: unknown = Reflect.get(candidate, "type")
    let nativeResponseState = false
    if (responseImplementationConstructor) {
      try {
        const responsePrototype = responseImplementationConstructor.prototype
        const responseGetters = ["status", "statusText", "headers", "body", "bodyUsed", "type"] as const
        const responseValues = [status, statusText, headers, body, bodyUsed, type]
        nativeResponseState = responseGetters.every((key, index) => {
          const getter = Object.getOwnPropertyDescriptor(responsePrototype, key)?.get
          return getter !== undefined && Reflect.apply(getter, candidate, []) === responseValues[index]
        })
      }
      catch {
        nativeResponseState = false
      }
    }
    // Response.error() is the one valid status-zero response. Preserve it before
    // applying ordinary HTTP status validation; reconstructing it with Response
    // would reject status 0 and lose its error type.
    if (status === 0 && statusText === "" && body === null && type === "error" && nativeResponseState) {
      return responseImplementationConstructor === Response ? value as Response : Response.error()
    }
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- A response snapshot needs an integer HTTP status before constructing the local Response.
    if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) return
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Response status text is an opaque boundary string validated by the local Response constructor below.
    if (typeof statusText !== "string") return
    if (bodyUsed !== undefined && typeof bodyUsed !== "boolean") return
    if (headers === null || Object(headers) !== headers) return
    // Response construction rejects bodies for these status codes. Check this
    // before transferring a foreign stream so a rejected candidate retains
    // ownership of its original body.
    if (body !== null && (status === 204 || status === 205 || status === 304)) return

    const headerCarrier = Object(headers)
    const snapshot = { status, statusText, headers, body }
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
    const nativeHeaderMethods = ["get", "forEach"].every(key =>
      responsePropertyDescriptor(headerCarrier, key)?.value === Object.getOwnPropertyDescriptor(Headers.prototype, key)?.value)
    // A foreign implementation must carry its own native Headers methods.
    // Accepting a foreign Response prototype paired with current-realm Headers
    // would make a user-defined Response-shaped object indistinguishable from
    // a genuine cross-runtime response.
    const cookieDescriptor = responsePropertyDescriptor(headerCarrier, "getSetCookie")
    const nativeCookieMethod = !cookieDescriptor?.get && (cookieDescriptor?.value === undefined
      || cookieDescriptor.value === Object.getOwnPropertyDescriptor(Headers.prototype, "getSetCookie")?.value)
    const nativeBodyMethod = body === null
      || responsePropertyDescriptor(Object(body), "getReader")?.value === ReadableStream.prototype.getReader
    if (value instanceof Response && bodyUsed !== true && nativeProperties && nativeBodyUnused && nativeHeaderMethods && nativeCookieMethod && nativeBodyMethod) return value
    if (bodyUsed === true && body !== null) return
    if (!isSerializableAuthorizationBody(body)) return
    const headerMethods = authorizationHeaderMethods(headerCarrier)
    if (!headerMethods) return
    const { forEach, getSetCookie } = headerMethods
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Headers.getSetCookie is optional across runtimes; capture its result once when callable.
    const cookies: unknown = getSetCookie ? Reflect.apply(getSetCookie, headers, []) : []
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

    // Validate non-body constructor inputs before transferring a foreign stream.
    if (status === 0 && (statusText !== "" || body !== null || [...normalizedHeaders].length !== 0)) return
    if (status !== 0) new Response(null, { status, statusText, headers: normalizedHeaders })

    if (body === null) {
      return status === 0 && statusText === "" && [...normalizedHeaders].length === 0
        ? Response.error()
        : new Response(null, { status, statusText, headers: normalizedHeaders })
    }
    const bridgedBody = bridgeAuthorizationBody(body)
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
