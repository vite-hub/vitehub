import discoveredDefinition from "#vitehub/auth/definition"
import { betterAuth } from "better-auth"
import { normalizeAuthBasePath } from "./shared.ts"
import { resolveAuthMountPath } from "./application-path.ts"
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

const intrinsicPromiseThen = Promise.prototype.then
const intrinsicPromiseConstructor = Promise

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

/**
 * Only `true` grants access. A Response of this runtime is sent as the rejection. Every other value gets `403`.
 */
async function runAccessAuthorize(
  authorize: AuthAccessAuthorize,
  context: AuthAccessAuthorizationContext,

): Promise<{ response?: Response }> {
  const result = authorize(context)
  const directResponse = await normalizeAuthorizationResponse(result)
  if (directResponse) return { response: directResponse }

  if (result !== null && (typeof result === "object" || typeof result === "function")) {
    const settle = async (resolved: unknown): Promise<{ response?: Response }> => {
      const response = await normalizeAuthorizationResponse(resolved)
      if (response) return { response }
      if (resolved !== true) return { response: createForbiddenResponse(context.request) }
      return {}
    }
    let branded = false
    const adopted = new Promise<{ response?: Response }>((resolve, reject) => {
      const attach = () => Reflect.apply(intrinsicPromiseThen, result, [
        (resolved: unknown) => { void settle(resolved).then(resolve, reject) }, reject,
      ])
      try {
        attach()
        branded = true
      }
      catch (error) {
        // A throwing species can prevent reaction installation. Retry with a
        // native constructor where the instance permits temporary replacement.
        let owner: object | undefined
        let descriptor: PropertyDescriptor | undefined
        let current: object | null = result
        while (current) {
          const candidate = Object.getOwnPropertyDescriptor(current, "constructor")
          if (candidate) { owner = current; descriptor = candidate; break }
          current = Object.getPrototypeOf(current)
        }
        try {
          if (!descriptor || descriptor.configurable) {
            Object.defineProperty(owner ?? result, "constructor", { configurable: true, value: Promise })
            try { attach(); branded = true }
            finally {
              if (descriptor) Object.defineProperty(owner!, "constructor", descriptor)
              else Reflect.deleteProperty(owner ?? result, "constructor")
            }
          }
          else {
            const constructor = Reflect.get(result, "constructor")
            const species = constructor !== null && (typeof constructor === "object" || typeof constructor === "function")
              ? Object.getOwnPropertyDescriptor(constructor, Symbol.species)
              : undefined
            if (!species?.configurable) throw error
            Object.defineProperty(constructor, Symbol.species, { configurable: true, value: Promise })
            try { attach(); branded = true }
            finally { Object.defineProperty(constructor, Symbol.species, species) }
          }
        }
        catch {
          // A native promise resolver performs adoption and observes the source;
          // keep this branded value out of the reflective thenable path without
          // dispatching through the mutable Promise.resolve static method.
          branded = true
          // Promise resolution performs another observable `then` lookup. If
          // the value has an own override, mask it while creating the native
          // adoption promise so the fallback cannot dispatch that override.
          const ownThen = Object.getOwnPropertyDescriptor(result, "then")
          let masked = false
          let maskDescriptor: PropertyDescriptor | undefined
          if (!ownThen || ownThen.configurable || ("value" in ownThen && ownThen.writable)) {
            try {
              Object.defineProperty(result, "then", {
                configurable: ownThen?.configurable ?? true,
                enumerable: ownThen?.enumerable ?? false,
                value: intrinsicPromiseThen,
                writable: ownThen?.writable ?? true,
              })
              masked = true
              maskDescriptor = ownThen
            }
            catch {
              // Frozen instances cannot be masked; leave the native resolver
              // to report the source settlement or its unavoidable override.
            }
          }
          let nativeAdopted: Promise<unknown>
          try {
            nativeAdopted = new intrinsicPromiseConstructor(resolve => resolve(result))
          }
          finally {
            if (masked) {
              if (maskDescriptor) Object.defineProperty(result, "then", maskDescriptor)
              else Reflect.deleteProperty(result, "then")
            }
          }
          void Reflect.apply(intrinsicPromiseThen, nativeAdopted, [
            (value: unknown) => { void settle(value).then(resolve, reject) }, reject,
          ])
        }
      }
    })
    if (branded) return adopted
  }

  let thenMethod: unknown
  try {
    thenMethod = result !== null && (typeof result === "object" || typeof result === "function")
      ? Reflect.get(result, "then")
      : undefined
  }
  catch (error) {
    return Promise.reject(error)
  }
  if (typeof thenMethod !== "function") return { response: result !== true ? createForbiddenResponse(context.request) : undefined }
  const assimilated = new Promise<unknown>((resolve, reject) => {
    queueMicrotask(() => {
      try { Reflect.apply(thenMethod, result, [resolve, reject]) }
      catch (error) { reject(error) }
    })
  })
  return assimilated.then(async resolved => {
    const response = await normalizeAuthorizationResponse(resolved)
    if (response) return { response }
    if (resolved !== true) return { response: createForbiddenResponse(context.request) }
    return {}
  })
}

const authorizationResponseProperties = ["status", "statusText", "headers", "body"] as const

// Capture the platform accessors before user authorization code can mutate the
// global prototype.  Later provenance checks must compare against these stable
// references rather than whatever descriptors happen to be installed now.
const trustedResponseGetters = Object.fromEntries(
  authorizationResponseProperties.map(key => [key, Object.getOwnPropertyDescriptor(Response.prototype, key)?.get]),
) as Record<typeof authorizationResponseProperties[number], (() => unknown) | undefined>
const nativeResponsePrototype = Response.prototype
const nativeResponseConstructor = Response

function hasTrustedResponseDescriptors(prototype: object): boolean {
  return authorizationResponseProperties.every(key =>
    Object.getOwnPropertyDescriptor(prototype, key)?.get === trustedResponseGetters[key])
}

const authorizationResponsePrototypeLimit = 32
const trustedReadableStreamGetReader = ReadableStream.prototype.getReader

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

  }
  catch {
    return false
  }
  return false
}

const authorizationReaderMethods = new WeakMap<object, () => unknown>()

function isSerializableAuthorizationBody(body: unknown): body is ReadableStream<Uint8Array> | null {
  if (body === null) return true
  if (Object(body) !== body) return false
  let prototype: object | null = Object.getPrototypeOf(body)
  const seen = new Set<object>()
  let locked: (() => boolean) | undefined
  let getReader: (() => unknown) | undefined
  let lockedOwner: object | undefined
  let readerOwner: object | undefined
  for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
    if (seen.has(prototype)) return false
    seen.add(prototype)
    const lockedDescriptor = Object.getOwnPropertyDescriptor(prototype, "locked")
    const readerDescriptor = Object.getOwnPropertyDescriptor(prototype, "getReader")
    if (!locked && typeof lockedDescriptor?.get === "function") {
      locked = lockedDescriptor.get
      lockedOwner = prototype
    }
    if (!getReader && typeof readerDescriptor?.value === "function") {
      getReader = readerDescriptor.value
      readerOwner = prototype
    }
    if (locked && getReader) break
    prototype = Object.getPrototypeOf(prototype)
  }
  if (!locked || !getReader) return false
  const trustedLocked = (() => {
    let owner: object | null = Object.getPrototypeOf(body)
    let intrinsic: (() => boolean) | undefined
    const owners = new Set<object>()
    for (let depth = 0; owner && depth < authorizationResponsePrototypeLimit; depth++) {
      if (owners.has(owner)) break
      owners.add(owner)
      const getter = Object.getOwnPropertyDescriptor(owner, "locked")?.get
      if (typeof getter === "function") intrinsic = getter
      owner = Object.getPrototypeOf(owner)
    }
    return intrinsic
  })()
  if (!trustedLocked || Reflect.apply(trustedLocked, body, [])) return false
  const ownLocked = Object.getOwnPropertyDescriptor(body, "locked")
  if (ownLocked) return false
  const ownReader = Object.getOwnPropertyDescriptor(body, "getReader")
  if (ownReader && ownReader.value !== getReader) return false
  // Authenticate reader ownership: releasing the probed reader must unlock the
  // same fresh stream. An override that returns a reader from another stream
  // leaves the probed stream locked and fails closed.
  try {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(lockedOwner, "constructor")
    const constructor = constructorDescriptor?.value
    if (typeof constructor !== "function") return false
    // A subclass that replaces the stream implementation's reader method can
    // return a reader owned by an unrelated stream. Preserve subclasses that
    // inherit their realm's native method, but fail closed for overrides.
    let delegatedReaderOverride = false
    if (getReader !== trustedReadableStreamGetReader) {
      // A subclass may wrap both accessors while delegating to the native
      // implementation.  Keep that supported shape, but reject arbitrary
      // constructor-owned overrides that can return a reader for another
      // stream.
      const readerSource = Function.prototype.toString.call(getReader)
      if (!readerSource.includes("super.getReader")) return false
      delegatedReaderOverride = true
    }
    const intrinsicReader = Object.getOwnPropertyDescriptor(constructor.prototype, "getReader")?.value
    if (!delegatedReaderOverride && intrinsicReader !== getReader) return false
    const fresh = new constructor()
    const probed = Reflect.apply(getReader, fresh, [])
    if (!Reflect.apply(trustedLocked, fresh, [])) return false
    const release = Object(probed) === probed ? Object.getPrototypeOf(probed)?.releaseLock : undefined
    if (typeof release !== "function") return false
    Reflect.apply(release, probed, [])
    const valid = !Reflect.apply(trustedLocked, fresh, [])
    if (valid && Object(body) === body) authorizationReaderMethods.set(body, getReader)
    return valid
  }
  catch { return false }
}

function authorizationBodyReader(body: object): (() => unknown) | undefined {
  const authenticated = authorizationReaderMethods.get(body)
  if (authenticated) return authenticated
  let prototype: object | null = Object.getPrototypeOf(body)
  const seen = new Set<object>()
  let first: (() => unknown) | undefined
  for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
    if (seen.has(prototype)) return
    seen.add(prototype)
    const reader = Object.getOwnPropertyDescriptor(prototype, "getReader")?.value
    if (typeof reader === "function") {
      if (!first) {
        first = reader
      }
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  return first
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
  let locked: (() => boolean) | undefined
  let released = false
  const acquire = async () => {
    initializing ??= Promise.resolve().then(() => {
      const acquired = Reflect.apply(getReader, body, [])
      try {
      if (!locked) {
        let owner: object | null = Object.getPrototypeOf(body)
        const seenOwners = new Set<object>()
        for (let depth = 0; owner && depth < authorizationResponsePrototypeLimit; depth++) {
          if (seenOwners.has(owner)) break
          seenOwners.add(owner)
          const getter = Object.getOwnPropertyDescriptor(owner, "locked")?.get
          if (typeof getter === "function") { locked = getter as () => boolean; break }
          owner = Object.getPrototypeOf(owner)
        }
      }
      if (!locked || !Reflect.apply(locked, body, [])) throw new Error("Malformed authorization reader")
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
      catch (error) {
        try {
          const release = Object(acquired) === acquired
            ? Object.getPrototypeOf(acquired)?.releaseLock
            : undefined
          if (typeof release === "function") Reflect.apply(release, acquired, [])
        }
        catch { /* preserve the original validation error */ }
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
        const sourceRead = read
        if (!sourceRead) throw new Error("Malformed authorization reader")
        const result = await Reflect.apply(sourceRead, sourceReader, []) as { done: boolean; value?: Uint8Array }
        if (result.done) {
          release()
          controller.close()
        }
        else {
          const value = result.value
          if (!isIntrinsicUint8Array(value) || !intrinsicTypedArrayByteLengthGetter || typeof intrinsicUint8ArraySet !== "function") {
            throw new Error("Malformed authorization read result")
          }
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
    const bodyUsed: unknown = Reflect.get(candidate, "bodyUsed")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- A response snapshot needs an integer HTTP status before constructing the local Response.
    if (typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > 599) return

    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Response status text is an opaque boundary string validated by the local Response constructor below.
    if (typeof statusText !== "string") return
    if (headers === null || Object(headers) !== headers) return

    const headerCarrier = Object(headers)
    const snapshot = { status, statusText, headers, body }
    if (!(value instanceof localResponseConstructor) && body !== null && bodyUsed === true) return
    let intrinsicStatus: unknown
    let intrinsicStatusText: unknown
    let intrinsicHeaders: unknown
    let intrinsicBody: unknown
    try {
      const trustedGetters = new Map<string, Set<unknown>>([
        ["status", new Set<unknown>()],
        ["statusText", new Set<unknown>()],
        ["headers", new Set<unknown>()],
        ["body", new Set<unknown>()],
      ])
      for (const responsePrototype of [
        Response.prototype,
        (await getUndiciResponse())?.prototype,
      ]) {
        if (!responsePrototype) continue
        for (const key of trustedGetters.keys()) {
          const getter = Object.getOwnPropertyDescriptor(responsePrototype, key)?.get
          if (getter) trustedGetters.get(key)?.add(getter)
        }
      }
      let prototype: object | null = Object.getPrototypeOf(candidate)
      const seen = new Set<object>()
      for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
        if (seen.has(prototype)) break
        seen.add(prototype)
        const statusGetter = Object.getOwnPropertyDescriptor(prototype, "status")?.get
        const statusTextGetter = Object.getOwnPropertyDescriptor(prototype, "statusText")?.get
        const headersGetter = Object.getOwnPropertyDescriptor(prototype, "headers")?.get
        const bodyGetter = Object.getOwnPropertyDescriptor(prototype, "body")?.get
        if (statusGetter && statusTextGetter && headersGetter && bodyGetter
          && trustedGetters.get("status")?.has(statusGetter)
          && trustedGetters.get("statusText")?.has(statusTextGetter)
          && trustedGetters.get("headers")?.has(headersGetter)
          && trustedGetters.get("body")?.has(bodyGetter)) {
          intrinsicStatus = Reflect.apply(statusGetter, candidate, [])
          intrinsicStatusText = Reflect.apply(statusTextGetter, candidate, [])
          intrinsicHeaders = Reflect.apply(headersGetter, candidate, [])
          intrinsicBody = Reflect.apply(bodyGetter, candidate, [])
          break
        }
        prototype = Object.getPrototypeOf(prototype)
      }
    }
    catch { /* malformed or shadowed response state */ }
    if (value instanceof Response && status === 0 && statusText === "" && body === null
      && headers instanceof Headers
      && intrinsicStatus === 0 && intrinsicStatusText === "" && intrinsicBody === null
      && intrinsicHeaders !== null && typeof intrinsicHeaders === "object"
      && authorizationResponseProperties.every(key =>
        responsePropertyDescriptor(candidate, key)?.get === Object.getOwnPropertyDescriptor(Response.prototype, key)?.get)
      && !authorizationResponseProperties.some(key => Object.prototype.hasOwnProperty.call(candidate, key))) return value
    const nativeDescriptors = value instanceof Response && authorizationResponseProperties.every(key =>
      responsePropertyDescriptor(candidate, key)?.get === Object.getOwnPropertyDescriptor(Response.prototype, key)?.get)

    const thenDescriptor = responsePropertyDescriptor(candidate, "then")
    const hasCallableOwnThen = typeof thenDescriptor?.value === "function" || typeof thenDescriptor?.get === "function"
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

    const cookieDescriptor = responsePropertyDescriptor(headerCarrier, "getSetCookie")
    const nativeCookieMethod = !cookieDescriptor?.get && (cookieDescriptor?.value === undefined
      || cookieDescriptor.value === Object.getOwnPropertyDescriptor(Headers.prototype, "getSetCookie")?.value)
    const nativeBodyMethod = body === null || responsePropertyDescriptor(Object(body), "getReader")?.value === ReadableStream.prototype.getReader
    let serializableBody = body === null
    if (body !== null) {
      try {
        serializableBody = isSerializableAuthorizationBody(body)
      }
      catch {
        // A response from another Fetch realm cannot be branded by this realm.
        // Keep it on the normalization and body-bridge path instead.
      }
    }
    if (value instanceof localResponseConstructor && !hasCallableOwnThen && nativeProperties && nativeHeaderMethods && nativeCookieMethod && nativeBodyMethod) return value
    if (!serializableBody) return
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
      && intrinsicStatus === 0 && intrinsicStatusText === "" && intrinsicBody === null
      && intrinsicHeaders !== null && typeof intrinsicHeaders === "object"
      ? Response.error()
      : new Response(null, { status, statusText, headers: normalizedHeaders })
    if (body === null) return normalizedResponse
    const getReader = authorizationBodyReader(body as object)
    if (!getReader) return
    const bridgedBody = bridgeAuthorizationBody(body as ReadableStream<Uint8Array>, getReader)
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
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Route configuration crosses JavaScript realms; runtime object narrowing preserves foreign authorize callbacks.
      const authorize = typeof route === "object" && route !== null ? route.authorize : undefined
      if (!authorize && requiredAuthorizeRoutes.has(routeIndexes[index]!)) {
        return reject(createForbiddenResponse(request))
      }
      if (!authorize) continue
      const rejection = await runAccessAuthorize(authorize, authorization)
      if (rejection.response) return reject(rejection.response)
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
  return rejection.response ? reject(rejection.response) : { authorization }
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
