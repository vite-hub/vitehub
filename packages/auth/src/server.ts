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

const intrinsicTypedArrayTagGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Int8Array.prototype), Symbol.toStringTag,
)?.get
const intrinsicUint8ArrayConstructor = Uint8Array
const intrinsicTypedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")?.get
const intrinsicUint8ArraySet = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "set")?.value
function isIntrinsicUint8Array(value: unknown): value is Uint8Array {
  if (!intrinsicTypedArrayTagGetter) return false
  try { return Reflect.apply(intrinsicTypedArrayTagGetter, value, []) === "Uint8Array" }
  catch { return false }
}


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
    let prototype: object | null = Object.getPrototypeOf(value)
    const seen = new Set<object>()
    for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (prototype === Response.prototype) return true
      if (seen.has(prototype)) return false
      seen.add(prototype)
      prototype = Object.getPrototypeOf(prototype)
    }
  }
  catch {
    // Foreign responses and malformed objects fail the current-realm check.
  }
  return false
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
  const directResult = authorize(context)
  // Normalize direct results before promise assimilation. A genuine Response
  // may expose an own `then` property, and reading that property can throw.
  const directResponse = await normalizeAuthorizationResponse(directResult)
  if (directResponse) return directResponse
  const result = await directResult
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

const nativeReaderMethods = Object.fromEntries(([
  "read", "cancel", "releaseLock",
] as const).map(key => [key, Object.getOwnPropertyDescriptor(ReadableStreamDefaultReader.prototype, key)?.value])) as Record<string, unknown>
const nativeStreamGetReader = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "getReader")?.value
function isNativeReaderMethod(value: unknown, key: string): value is (...args: unknown[]) => unknown {
  return value === nativeReaderMethods[key]
}

const foreignReaderMethods = new WeakMap<Function, Record<string, Function>>()

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
          // Proxies do not expose the native internal response brand.
          // Reject them rather than trusting ordinary forwarded properties.
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
    if (Object.prototype.hasOwnProperty.call(body, "locked") || Object.prototype.hasOwnProperty.call(body, "getReader")) return false
    let prototype: object | null = Object.getPrototypeOf(body)
    const seen = new Set<object>()
    let lockedGetter: ((this: object) => unknown) | undefined
    let getReader: ((this: object) => unknown) | undefined
    let owner: object | undefined
    for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (seen.has(prototype)) return false
      seen.add(prototype)
      const lockedDescriptor = Object.getOwnPropertyDescriptor(prototype, "locked")
      const readerDescriptor = Object.getOwnPropertyDescriptor(prototype, "getReader")
      if (!lockedGetter && typeof lockedDescriptor?.get === "function") {
        lockedGetter = lockedDescriptor.get as (this: object) => unknown
        owner = prototype
      }
      if (!getReader && typeof readerDescriptor?.value === "function") {
        getReader = readerDescriptor.value as (this: object) => unknown
        owner = prototype
      }
      if (lockedGetter && getReader) break
      prototype = Object.getPrototypeOf(prototype)
    }
    if (!lockedGetter || !getReader || Reflect.apply(lockedGetter, body, []) !== false) return false
    return getReader as (this: object) => ReadableStreamDefaultReader<Uint8Array>
  }
  catch {
    return false
  }
}

type AuthorizationReaderMethods = {
  read: (this: object, ...args: unknown[]) => unknown
  cancel: (this: object, ...args: unknown[]) => unknown
  releaseLock: (this: object, ...args: unknown[]) => unknown
}

function getNativeAuthorizationReaderMethods(reader: object): AuthorizationReaderMethods | undefined {
  if (Object.prototype.hasOwnProperty.call(reader, "read")
    || Object.prototype.hasOwnProperty.call(reader, "cancel")
    || Object.prototype.hasOwnProperty.call(reader, "releaseLock")) return
  try {
    let prototype: object | null = Object.getPrototypeOf(reader)
    const seen = new Set<object>()
    const methods: Partial<AuthorizationReaderMethods> = {}
    const owners = new Set<object>()
    let closed: ((this: object) => unknown) | undefined
    let closedOwner: object | undefined
    for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (seen.has(prototype)) return
      seen.add(prototype)
      const closedDescriptor = Object.getOwnPropertyDescriptor(prototype, "closed")
      if (!closed && typeof closedDescriptor?.get === "function") {
        closed = closedDescriptor.get as (this: object) => unknown
        closedOwner = prototype
      }
      for (const key of ["read", "cancel", "releaseLock"] as const) {
        if (methods[key]) continue
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
        if (typeof descriptor?.value === "function") {
          methods[key] = descriptor.value as AuthorizationReaderMethods[typeof key]
          owners.add(prototype)
        }
      }
      if (closed && methods.read && methods.cancel && methods.releaseLock) break
      prototype = Object.getPrototypeOf(prototype)
    }
    if (!closed || !closedOwner || !methods.read || !methods.cancel || !methods.releaseLock || owners.size !== 1 || !owners.has(closedOwner)) return
    // Applying the source runtime's closed getter is an unforgeable reader
    // brand check; callable method shape alone is insufficient.
    Reflect.apply(closed, reader, [])
    return methods as AuthorizationReaderMethods
  }
  catch {
    return
  }
}

function releaseAuthorizationReader(reader: object, trustedRelease?: Function): void {
  try {
    const release = trustedRelease ?? Reflect.get(reader, "releaseLock")
    if (typeof release === "function") Reflect.apply(release, reader, [])
  }
  catch { /* best effort cleanup */ }
}

function isSerializableAuthorizationBody(body: unknown, reader: unknown): body is ReadableStream<Uint8Array> {
  return (body === null || (typeof body === "object" && typeof reader === "function"))
}

const typedArrayTagGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get

function isNativeUint8ArrayChunk(value: unknown): value is Uint8Array {
  if (!ArrayBuffer.isView(value) || typeof typedArrayTagGetter !== "function") return false
  try {
    return Reflect.apply(typedArrayTagGetter, value, []) === "Uint8Array"
  }
  catch {
    return false
  }
}

function bridgeAuthorizationBody(
  body: ReadableStream<Uint8Array>,

  getReader: (this: object) => ReadableStreamDefaultReader<Uint8Array>,
) {
  // Defer acquisition until the normalized body is consumed or canceled. This
  // preserves the source stream's unlocked state for unconsumed responses.
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let methods: ReturnType<typeof getNativeAuthorizationReaderMethods>
  let initialization: Promise<NonNullable<typeof methods>> | undefined
  const initialize = () => initialization ??= Promise.resolve().then(() => {
    const nextReader = Reflect.apply(getReader, body, [])
    let trustedRelease: Function | undefined
    let releasePrototype: object | null = Object.getPrototypeOf(nextReader)
    while (releasePrototype && !trustedRelease) {
      const descriptor = Object.getOwnPropertyDescriptor(releasePrototype, "releaseLock")
      if (typeof descriptor?.value === "function") trustedRelease = descriptor.value
      releasePrototype = Object.getPrototypeOf(releasePrototype)
    }
    try {
      const nextMethods = getNativeAuthorizationReaderMethods(nextReader)
      if (!nextMethods) throw new TypeError("Invalid ReadableStreamDefaultReader")
      reader = nextReader
      methods = nextMethods
      return nextMethods
    }
    catch (error) {
      releaseAuthorizationReader(nextReader, trustedRelease)
      throw error
    }
  })
  let released = false
  const release = () => {
    if (released || !reader || !methods) return
    released = true
    Reflect.apply(methods.releaseLock, reader, [])
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {

        const { read } = await initialize()
        const result = await Reflect.apply(read, reader!, []) as { done: boolean; value?: Uint8Array }
        if (result.done) {
          release()
          controller.close()
        }
        else {

          const value = result.value
          if (!isIntrinsicUint8Array(value)) throw new Error("Malformed authorization read result")
          if (!intrinsicTypedArrayByteLengthGetter || typeof intrinsicUint8ArraySet !== "function") throw new Error("Malformed authorization read result")
          const copy = new intrinsicUint8ArrayConstructor(Reflect.apply(intrinsicTypedArrayByteLengthGetter, value, []))
          Reflect.apply(intrinsicUint8ArraySet, copy, [value])
          controller.enqueue(copy)

        }
      }
      catch (error) {
        release()
        controller.error(error)
      }

    },
    async cancel(reason) {
      try {
        const { cancel } = await initialize()
        await Reflect.apply(cancel, reader!, [reason])
      }
      finally { release() }
    },
  }, { highWaterMark: 0 })
  return { stream, release, ready: undefined }
}

async function normalizeAuthorizationResponse(value: unknown): Promise<Response | undefined> {
  if (value === null || Object(value) !== value) return
  // A native Response from this Fetch implementation is already safe to
  // return, including responses whose body has been consumed or locked. The
  // intrinsic status getter is a realm-independent internal-slot check and
  // does not inspect body state.
  if (isRuntimeResponse(value)) return value
  try {
    const candidate = Object(value)
    if (!await hasResponsePrototype(candidate)) return
    // Own data properties can shadow native response fields on a spoof.
    if (authorizationResponseProperties.some(key => Object.prototype.hasOwnProperty.call(candidate, key))) return
    // Snapshot ordinary property reads once. Prototype shape is not proof of origin.
    const status: unknown = Reflect.get(candidate, "status")
    const statusText: unknown = Reflect.get(candidate, "statusText")
    const headers: unknown = Reflect.get(candidate, "headers")
    let body: unknown = Reflect.get(candidate, "body")
    const bodyUsed: unknown = Reflect.get(candidate, "bodyUsed")
    // Read the response's intrinsic bodyUsed getter as well as the ordinary
    // snapshot. A consumed stream may release its reader and shadow bodyUsed
    // with false; the source-runtime getter still reports its disturbed state
    // without acquiring the body stream's reader.
    let intrinsicBodyUsed: unknown
    try {
      const trustedBodyUsedGetters = new Set<unknown>()
      const localBodyUsedGetter = Object.getOwnPropertyDescriptor(Response.prototype, "bodyUsed")?.get
      if (localBodyUsedGetter) trustedBodyUsedGetters.add(localBodyUsedGetter)
      const UndiciResponse = await getUndiciResponse()
      const foreignBodyUsedGetter = UndiciResponse && Object.getOwnPropertyDescriptor(UndiciResponse.prototype, "bodyUsed")?.get
      if (foreignBodyUsedGetter) trustedBodyUsedGetters.add(foreignBodyUsedGetter)
      let prototype: object | null = Object.getPrototypeOf(candidate)
      const seen = new Set<object>()
      for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
        if (seen.has(prototype)) break
        seen.add(prototype)
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "bodyUsed")
        if (descriptor) {
          if (typeof descriptor.get !== "function" || !trustedBodyUsedGetters.has(descriptor.get)) return
          intrinsicBodyUsed = Reflect.apply(descriptor.get, candidate, [])
          break
        }
        prototype = Object.getPrototypeOf(prototype)
      }
    }
    catch {
      return
    }
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- A response snapshot needs an integer HTTP status before constructing the local Response.
    if (typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > 599) return
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Response status text is an opaque boundary string validated by the local Response constructor below.
    if (typeof statusText !== "string") return
    if (headers === null || Object(headers) !== headers) return
    if (typeof bodyUsed !== "boolean" || bodyUsed || intrinsicBodyUsed !== false) return
    // Response construction rejects bodies for these status codes. Check this
    // before transferring a foreign stream so a rejected candidate retains
    // ownership of its original body.
    if (body !== null && (status === 204 || status === 205 || status === 304)) return

    const headerCarrier = Object(headers)
    const snapshot = { status, statusText, headers, body }
    if (value instanceof Response && status === 0 && statusText === "" && body === null
      && headers instanceof Headers
      && authorizationResponseProperties.every(key =>
        responsePropertyDescriptor(candidate, key)?.get === Object.getOwnPropertyDescriptor(Response.prototype, key)?.get)
      && !authorizationResponseProperties.some(key => Object.prototype.hasOwnProperty.call(candidate, key))) return value
    const nativeDescriptors = value instanceof Response && authorizationResponseProperties.every(key =>
      responsePropertyDescriptor(candidate, key)?.get === nativeResponseDescriptors[key]?.get)
    let nativeProperties = false
    let nativeBodyUnused = false
    let foreignBodyUnused = true
    try {
      nativeProperties = nativeDescriptors && authorizationResponseProperties.every(key => {
        const getter = nativeResponseDescriptors[key]?.get
        return getter && Reflect.apply(getter, candidate, []) === snapshot[key]
      })
      const bodyUsedGetter = Object.getOwnPropertyDescriptor(Response.prototype, "bodyUsed")?.get
      const lockedGetter = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")?.get
      nativeBodyUnused = Boolean(bodyUsedGetter && !Reflect.apply(bodyUsedGetter, candidate, []))
        && (body === null || Boolean(lockedGetter && !Reflect.apply(lockedGetter, body, [])))
      if (!(value instanceof Response)) {
        let prototype: object | null = Object.getPrototypeOf(candidate)
        let foreignBodyUsedGetter: ((this: object) => boolean) | undefined
        for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "bodyUsed")
          if (descriptor?.get) {
            foreignBodyUsedGetter = descriptor.get as (this: object) => boolean
            break
          }
          prototype = Object.getPrototypeOf(prototype)
        }
        foreignBodyUnused = Boolean(foreignBodyUsedGetter && !Reflect.apply(foreignBodyUsedGetter, candidate, []))
      }
    }
    catch {
      // A proxy can expose native descriptors without owning native response state.
    }
    const headerPrototype = Object.getPrototypeOf(headerCarrier)
    const nativeHeaderMethods = headerPrototype !== null && ["get", "forEach"].every(key =>
      responsePropertyDescriptor(headerCarrier, key)?.value === Object.getOwnPropertyDescriptor(headerPrototype, key)?.value)
    // A foreign implementation must carry its own native Headers methods.
    // Accepting a foreign Response prototype paired with current-realm Headers
    // would make a user-defined Response-shaped object indistinguishable from
    // a genuine cross-runtime response.
    const cookieDescriptor = responsePropertyDescriptor(headerCarrier, "getSetCookie")
    const nativeCookieMethod = !cookieDescriptor?.get && (cookieDescriptor?.value === undefined
      || cookieDescriptor.value === Object.getOwnPropertyDescriptor(headerPrototype, "getSetCookie")?.value)


    // Null-body responses have no stream to validate. Preserve the standard
    // status-zero error response across realms, while rejecting other foreign
    // null-body response-shaped values.
    if (body === null && !(value instanceof Response && nativeProperties && nativeHeaderMethods && nativeCookieMethod)
      && !(foreignBodyUnused && nativeHeaderMethods && nativeCookieMethod)
      && !(status === 0 && statusText === "" && [...new Headers(headers)].length === 0)) return

    let nativeBodyReader = body === null
      ? (() => { throw new Error("A null body has no reader") })
      : await getNativeAuthorizationBodyReader(body)
    if (value instanceof Response && nativeProperties && nativeBodyUnused && nativeHeaderMethods && nativeCookieMethod && nativeBodyReader) return value
    if (!nativeBodyReader || !isSerializableAuthorizationBody(body, nativeBodyReader)) return

    // Reader validation yields to the event loop. Re-read the source
    // response's intrinsic disturbed state immediately before acquiring the
    // bridge reader so a body consumed during validation cannot be admitted
    // after its reader is released and `locked` becomes false again.
    try {
      const trustedBodyUsedGetters = new Set<unknown>()
      const localBodyUsedGetter = Object.getOwnPropertyDescriptor(Response.prototype, "bodyUsed")?.get
      if (localBodyUsedGetter) trustedBodyUsedGetters.add(localBodyUsedGetter)
      const UndiciResponse = await getUndiciResponse()
      const foreignBodyUsedGetter = UndiciResponse && Object.getOwnPropertyDescriptor(UndiciResponse.prototype, "bodyUsed")?.get
      if (foreignBodyUsedGetter) trustedBodyUsedGetters.add(foreignBodyUsedGetter)
      let prototype: object | null = Object.getPrototypeOf(candidate)
      const seen = new Set<object>()
      let currentBodyUsed: unknown
      for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
        if (seen.has(prototype)) return
        seen.add(prototype)
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "bodyUsed")
        if (descriptor) {
          if (typeof descriptor.get !== "function" || !trustedBodyUsedGetters.has(descriptor.get)) return
          currentBodyUsed = Reflect.apply(descriptor.get, candidate, [])
          break
        }
        prototype = Object.getPrototypeOf(prototype)
      }
      if (currentBodyUsed !== false) return
    }
    catch {
      return
    }



    const forEach = Reflect.get(headerCarrier, "forEach")
    const getSetCookie = Reflect.get(headerCarrier, "getSetCookie")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Headers.getSetCookie is optional across runtimes; capture its result once when callable.
    const cookies: unknown = typeof getSetCookie === "function" ? Reflect.apply(getSetCookie, headers, []) : []
    if (!Array.isArray(cookies)) return
    // Without a cookie accessor, multiple Set-Cookie values may be collapsed.
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
    // Constructing a Response with a foreign body here would claim or disturb
    // the source stream before the lazy bridge can acquire it.
    if (body === null) {
      return status === 0 && statusText === "" && [...normalizedHeaders].length === 0
        ? Response.error()
        : new Response(null, { status, statusText, headers: normalizedHeaders })
    }
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
