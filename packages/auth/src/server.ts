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
  const targets = new Set<object>([Response.prototype])
  const UndiciResponse = await getUndiciResponse()
  if (UndiciResponse) targets.add(UndiciResponse.prototype)
  try {
    let current = Object.getPrototypeOf(Object(value))
    const seen = new Set<object>()
    for (let depth = 0; current && depth < authorizationResponsePrototypeLimit; depth++) {
      if (targets.has(current)) return true
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

async function isSerializableAuthorizationBody(body: unknown): Promise<boolean> {
  if (body === null) return true
  if (Object(body) !== body) return false
  try {
    const candidate = Object(body)
    // Resolve the stream intrinsics from the body's own realm. Applying the
    // getter performs the brand check and works across JavaScript realms.
    if (Object.getOwnPropertyDescriptor(candidate, "getReader")) return false
    let prototype: object | null = Object.getPrototypeOf(candidate)
    const seen = new Set<object>()
    let locked: (() => boolean) | undefined
    let getReader: (() => unknown) | undefined
    let lockedOwner: object | undefined
    for (let depth = 0; prototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (seen.has(prototype)) return false
      seen.add(prototype)
      const lockedDescriptor = Object.getOwnPropertyDescriptor(prototype, "locked")
      const readerDescriptor = Object.getOwnPropertyDescriptor(prototype, "getReader")
      if (!locked && typeof lockedDescriptor?.get === "function") {
        locked = lockedDescriptor.get
        lockedOwner = prototype
      }
      // Resolve the reader from the same intrinsic prototype as the branded
      // `locked` accessor. An intermediate prototype may shadow `getReader`;
      // that override must not replace the stream implementation we bridge.
      if (locked && !getReader && lockedOwner === prototype && typeof readerDescriptor?.value === "function") {
        getReader = readerDescriptor.value
      }
      if (locked && getReader) break
      prototype = Object.getPrototypeOf(prototype)
    }
    if (!locked || !getReader || Reflect.apply(locked, candidate, [])) return false
    // Let the local Fetch implementation apply its disturbed-stream check.
    // This catches foreign streams whose reader was consumed and released;
    // their `locked` accessor is false again, but the stream is no longer
    // transferable into a response.
    new Response(candidate)
    // Validate the reader against a fresh stream from the body's realm. This
    // avoids relying on function source text while rejecting unrelated native
    // methods (for example, Array.prototype.values) installed on the stream
    // prototype. The fresh stream is disposable, so invoking getReader does
    // not change the candidate's lock state.
    const streamConstructor = Object.getOwnPropertyDescriptor(lockedOwner, "constructor")?.value
    if (typeof streamConstructor !== "function") return false
    const freshStream = new streamConstructor()
    const reader = Reflect.apply(getReader, freshStream, [])
    // A reader returned from another stream can pass its own brand checks, but
    // it cannot lock this fresh stream. Verify ownership through the stream's
    // branded locked accessor before validating and releasing the reader.
    if (!Reflect.apply(locked, freshStream, [])) return false
    if (Object(reader) !== reader) return false
    const readerObject = Object(reader)
    if (typeof Reflect.get(readerObject, "read") !== "function"
      || typeof Reflect.get(readerObject, "cancel") !== "function"
      || typeof Reflect.get(readerObject, "releaseLock") !== "function") return false
    // A shape-compatible object is not sufficient: invoke the reader's
    // prototype releaseLock method so the stream implementation performs its
    // internal reader brand check. Own method replacements are rejected.
    if (Object.prototype.hasOwnProperty.call(readerObject, "read")
      || Object.prototype.hasOwnProperty.call(readerObject, "cancel")
      || Object.prototype.hasOwnProperty.call(readerObject, "releaseLock")) return false
    let readerPrototype: object | null = Object.getPrototypeOf(readerObject)
    let read: ((...args: []) => unknown) | undefined
    let cancel: ((...args: [unknown?]) => unknown) | undefined
    let releaseLock: (() => void) | undefined
    let closed: (() => unknown) | undefined
    const readerPrototypes = new Set<object>()
    for (let depth = 0; readerPrototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (readerPrototypes.has(readerPrototype)) return false
      readerPrototypes.add(readerPrototype)
      const readDescriptor = Object.getOwnPropertyDescriptor(readerPrototype, "read")
      const cancelDescriptor = Object.getOwnPropertyDescriptor(readerPrototype, "cancel")
      const descriptor = Object.getOwnPropertyDescriptor(readerPrototype, "releaseLock")
      const closedDescriptor = Object.getOwnPropertyDescriptor(readerPrototype, "closed")
      if (!read && typeof readDescriptor?.value === "function") read = readDescriptor.value
      if (!cancel && typeof cancelDescriptor?.value === "function") cancel = cancelDescriptor.value
      if (!closed && typeof closedDescriptor?.get === "function") closed = closedDescriptor.get
      if (!releaseLock && typeof descriptor?.value === "function") releaseLock = descriptor.value
      if (read && cancel && releaseLock && closed) break
      readerPrototype = Object.getPrototypeOf(readerPrototype)
    }
    if (!read || !cancel || !releaseLock || !closed) return false
    // The stream probe must validate every operation that the bridge will
    // invoke. A shadowed read or cancel method can otherwise fabricate data
    // or fail during consumption while releaseLock still appears genuine.
    let freshReaderPrototype: object | null = Object.getPrototypeOf(Object(reader))
    let freshRead: ((...args: []) => unknown) | undefined
    let freshCancel: ((...args: [unknown?]) => unknown) | undefined
    let freshReleaseLock: (() => void) | undefined
    const freshReaderPrototypes = new Set<object>()
    for (let depth = 0; freshReaderPrototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (freshReaderPrototypes.has(freshReaderPrototype)) return false
      freshReaderPrototypes.add(freshReaderPrototype)
      const readDescriptor = Object.getOwnPropertyDescriptor(freshReaderPrototype, "read")
      const cancelDescriptor = Object.getOwnPropertyDescriptor(freshReaderPrototype, "cancel")
      const releaseDescriptor = Object.getOwnPropertyDescriptor(freshReaderPrototype, "releaseLock")
      if (!freshRead && typeof readDescriptor?.value === "function") freshRead = readDescriptor.value
      if (!freshCancel && typeof cancelDescriptor?.value === "function") freshCancel = cancelDescriptor.value
      if (!freshReleaseLock && typeof releaseDescriptor?.value === "function") freshReleaseLock = releaseDescriptor.value
      if (freshRead && freshCancel && freshReleaseLock) break
      freshReaderPrototype = Object.getPrototypeOf(freshReaderPrototype)
    }
    if (read !== freshRead || cancel !== freshCancel || releaseLock !== freshReleaseLock) return false
    // Exercise the operations on branded readers as well as comparing their
    // identities. A replacement installed on the reader prototype is shared
    // by both the candidate and probe readers, so identity alone cannot catch
    // an operation that throws or returns a non-reader result.
    const probeStream = new streamConstructor({
      start(controller: { enqueue: (chunk: Uint8Array) => void; close: () => void }) {
        controller.enqueue(new Uint8Array([0]))
        controller.close()
      },
    })
    const probeReader = Reflect.apply(getReader, probeStream, [])
    if (Object(probeReader) !== probeReader) return false
    const probeReaderObject = Object(probeReader)
    const probeReadResult = Reflect.apply(read, probeReaderObject, [])
    if (Object(probeReadResult) !== probeReadResult || typeof Reflect.get(probeReadResult as object, "then") !== "function") return false
    const probeResult = await probeReadResult as { done?: unknown; value?: unknown }
    if (typeof probeResult.done !== "boolean") return false
    // `instanceof` is realm-sensitive, and prototype metadata can be forged.
    // The intrinsic %TypedArray%.prototype @@toStringTag getter performs a
    // cross-realm internal-brand check without consulting the value's mutable
    // prototype, so it distinguishes Uint8Array from clamped/other views.
    if (probeResult.done || !isIntrinsicUint8Array(probeResult.value)) return false
    let canceled = false
    const cancelStream = new streamConstructor({
      cancel() {
        canceled = true
      },
    })
    const cancelReader = Reflect.apply(getReader, cancelStream, [])
    if (Object(cancelReader) !== cancelReader) return false
    const cancelResult = Reflect.apply(cancel, Object(cancelReader), [])
    if (Object(cancelResult) !== cancelResult || typeof Reflect.get(cancelResult as object, "then") !== "function") return false
    if ((await cancelResult) !== undefined) return false
    if (!canceled) return false
    Reflect.apply(releaseLock, probeReaderObject, [])
    Reflect.apply(releaseLock, Object(cancelReader), [])
    // Validate the reader returned by the candidate body separately. A
    // shadowed getReader can return a reader-shaped object that only appears
    // valid because the probe above used that same override.
    const candidateReader = Reflect.apply(getReader, candidate, [])
    if (!Reflect.apply(locked, candidate, [])) return false
    if (Object(candidateReader) !== candidateReader) return false
    const candidateReaderObject = Object(candidateReader)
    if (Object.prototype.hasOwnProperty.call(candidateReaderObject, "read")
      || Object.prototype.hasOwnProperty.call(candidateReaderObject, "cancel")
      || Object.prototype.hasOwnProperty.call(candidateReaderObject, "releaseLock")) return false
    let candidateReaderPrototype: object | null = Object.getPrototypeOf(candidateReaderObject)
    let candidateRead: ((...args: []) => unknown) | undefined
    let candidateCancel: ((...args: [unknown?]) => unknown) | undefined
    let candidateReleaseLock: (() => void) | undefined
    const candidateReaderPrototypes = new Set<object>()
    for (let depth = 0; candidateReaderPrototype && depth < authorizationResponsePrototypeLimit; depth++) {
      if (candidateReaderPrototypes.has(candidateReaderPrototype)) return false
      candidateReaderPrototypes.add(candidateReaderPrototype)
      const readDescriptor = Object.getOwnPropertyDescriptor(candidateReaderPrototype, "read")
      const cancelDescriptor = Object.getOwnPropertyDescriptor(candidateReaderPrototype, "cancel")
      const releaseDescriptor = Object.getOwnPropertyDescriptor(candidateReaderPrototype, "releaseLock")
      if (!candidateRead && typeof readDescriptor?.value === "function") candidateRead = readDescriptor.value
      if (!candidateCancel && typeof cancelDescriptor?.value === "function") candidateCancel = cancelDescriptor.value
      if (!candidateReleaseLock && typeof releaseDescriptor?.value === "function") candidateReleaseLock = releaseDescriptor.value
      if (candidateRead && candidateCancel && candidateReleaseLock) break
      candidateReaderPrototype = Object.getPrototypeOf(candidateReaderPrototype)
    }
    if (candidateRead !== freshRead || candidateCancel !== freshCancel || candidateReleaseLock !== freshReleaseLock) return false
    Reflect.apply(candidateReleaseLock, candidateReaderObject, [])
    if (Reflect.apply(locked, candidate, [])) return false
    Reflect.apply(closed, readerObject, [])
    Reflect.apply(releaseLock, readerObject, [])
    // Releasing the reader must unlock the same fresh stream. An override can
    // otherwise lock the fresh stream while returning a reader from elsewhere.
    if (Reflect.apply(locked, freshStream, [])) return false
    // An intermediate prototype may intentionally shadow `getReader`; the
    // intrinsic method selected alongside the branded `locked` accessor is
    // the one we validated and will use for bridging.
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

function bridgeAuthorizationBody(
  body: ReadableStream<Uint8Array>,
  getReader: () => unknown,
) {
  const reader = Reflect.apply(getReader, body, [])
  let readerPrototype: object | null = Object.getPrototypeOf(Object(reader))
  let read: ((...args: []) => Promise<{ done: boolean; value: Uint8Array }>) | undefined
  let cancel: ((...args: [unknown?]) => Promise<void>) | undefined
  let releaseLock: (() => void) | undefined
  const seen = new Set<object>()
  for (let depth = 0; readerPrototype && depth < authorizationResponsePrototypeLimit; depth++) {
    if (seen.has(readerPrototype)) break
    seen.add(readerPrototype)
    const readDescriptor = Object.getOwnPropertyDescriptor(readerPrototype, "read")
    const cancelDescriptor = Object.getOwnPropertyDescriptor(readerPrototype, "cancel")
    const releaseDescriptor = Object.getOwnPropertyDescriptor(readerPrototype, "releaseLock")
    if (!read && typeof readDescriptor?.value === "function") read = readDescriptor.value
    if (!cancel && typeof cancelDescriptor?.value === "function") cancel = cancelDescriptor.value
    if (!releaseLock && typeof releaseDescriptor?.value === "function") releaseLock = releaseDescriptor.value
    if (read && cancel && releaseLock) break
    readerPrototype = Object.getPrototypeOf(readerPrototype)
  }
  if (!read || !cancel || !releaseLock) throw new Error("Malformed authorization reader")
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
        if (typeof result.done !== "boolean") throw new Error("Malformed authorization read result")
        if (result.done) {
          release()
          controller.close()
        } else if (!isIntrinsicUint8Array(result.value)) {
          release()
          controller.error(new Error("Malformed authorization read result"))
        } else controller.enqueue(result.value)
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
    // Snapshot ordinary property reads once. Prototype shape is not proof of origin.
    const status: unknown = Reflect.get(candidate, "status")
    const statusText: unknown = Reflect.get(candidate, "statusText")
    const headers: unknown = Reflect.get(candidate, "headers")
    const body: unknown = Reflect.get(candidate, "body")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- A response snapshot needs an integer HTTP status before constructing the local Response.
    if (typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > 599) return
    // The Fetch Response constructor rejects status 0 when a body is present.
    // Reject before acquiring the source reader so malformed responses cannot
    // leave a foreign stream locked.
    if (status === 0 && body !== null) return
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Response status text is an opaque boundary string validated by the local Response constructor below.
    if (typeof statusText !== "string") return
    if (headers === null || Object(headers) !== headers) return

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
    const nativeBodyMethod = body === null || responsePropertyDescriptor(Object(body), "getReader")?.value === ReadableStream.prototype.getReader
    let nativeBodyState = false
    try {
      const bodyUsed = Object.getOwnPropertyDescriptor(Response.prototype, "bodyUsed")?.get
      const locked = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")?.get
      nativeBodyState = bodyUsed !== undefined
        && !Reflect.apply(bodyUsed, candidate, [])
        && (body === null || (locked !== undefined && !Reflect.apply(locked, body, [])))
    }
    catch {
      // A proxy can expose native descriptors without owning native response state.
    }
    if (value instanceof Response && nativeProperties && nativeHeaderMethods && nativeCookieMethod && nativeBodyMethod && nativeBodyState) return value
    if (!await isSerializableAuthorizationBody(body)) return
    const serializableBody = body as ReadableStream<Uint8Array>
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

    // Foreign and shadowed values require a serializable local snapshot.
    const normalizedResponse = status === 0 && statusText === "" && body === null && [...normalizedHeaders].length === 0
      ? Response.error()
      : body === null
        ? new Response(null, { status, statusText, headers: normalizedHeaders })
        : (() => {
            const bridge = bridgeAuthorizationBody(serializableBody, authorizationBodyReader(Object(serializableBody)) ?? (() => undefined))
            try {
              return new Response(bridge.stream, { status, statusText, headers: normalizedHeaders })
            }
            catch (error) {
              bridge.release()
              throw error
            }
          })()
    // Foreign implementations and shadowed native values become stable local responses.
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
