import { createAuthConsole, type AuthConsole } from "../console-runtime.ts";
import type { AuthConsoleHostOptions, AuthConsoleOptions } from "../console-types.ts";
import abilities from "#vitehub/auth/abilities"
import { isRuntimeResponse } from "@vite-hub/runtime/internal/runtime-type"
import { betterAuth } from "better-auth"
import { HTTPError } from "h3"
import { resolveAuthMountPath } from "../application-path.ts"
import { normalizeAuthBasePath } from "../shared.ts"
import { authRequestEvent, unwrapAuthRequest } from "../request.ts"
import { resolveAuthOptions } from "../runtime-options.ts"
import { getAuthenticationSession, type AuthenticationSessionSnapshot } from "../session.ts"
import { getAuthRuntimeState } from "../runtime-state.ts"
import { withSessionMarker } from "../session-marker.ts"
import { eventClientAddress, setRequestClientAddress, withClientAddress } from "../client-address.ts"
import { createAuthAccessRouteMatcher } from "../runtime/server.ts"
import { checkAbility } from "../ability-check.ts"
import { AbilityError } from "../ability-error.ts"
import {
  authForRequest,
  createBetterAuthOptions,
  envResolverFor,
  getAuthForDefinition,
  requestProvider,
  resolveDefaultDefinition,
} from "../auth-instance.ts"

import type { AbilityArgs, AbilityAuthorization, AbilityName } from "../abilities.ts"
import type { AuthEventAggregates, AuthEventListInput, AuthEventPage, AuthEventStore, AuthEventWindow } from "../events.ts"
import type { AuthAccessIdentityResolver } from "../runtime-state.ts"
import type { AccessAuthorizeOption, ViteHubContext } from "@vite-hub/runtime"
import type {
  AuthAccessConfiguration,
  AuthAccessAuthorizationContext,
  AuthAccessRoute,
  AuthAnonymousAuthorization,
  AuthAnonymousAuthorize,
  AuthAnonymousGuardedHandler,
  AuthAuthorization,
  AuthBetterAuthRuntimeOptions,
  AuthDefinition,
  AuthFor,
  AuthGuardedHandler,
  AuthRequest,
  AuthRequestInput,
  AuthRuntimeOptions,
  AuthSignInConfiguration,
  RegisteredAuth,
  ResolvedAuthAccessRoute,
  ViteHubAuth,
} from "../types.ts"
import { authErrorDiagnostics } from "../error-diagnostics.ts"

export { createBetterAuthOptions, getAuthForDefinition } from "../auth-instance.ts"
export { resetAuth } from "../runtime-state.ts"
export { AbilityError } from "../ability-error.ts"
export type { AbilityErrorData } from "../ability-error.ts"
export { setAuthAccessIdentityResolver, setAuthRuntimeEnvResolver } from "../runtime/server.ts"

interface RequestInitWithDuplex extends RequestInit {
  duplex?: "half"
}

function hasHappyDomRequestState(value: object): boolean {
  const ownSymbols = Object.getOwnPropertySymbols(value)
  const prototypeSymbols = Object.getOwnPropertySymbols(Object.getPrototypeOf(value) ?? {})
  // Happy DOM stores its Request state in a fixed set of private symbols.
  // Partial lookalikes must stay on the normalization path.
  return [
    "method", "body", "mode", "headers", "redirect", "referrerPolicy",
    "signal", "bodyUsed", "credentials", "aborted", "error", "contentLength",
    "contentType", "referrer", "url", "bodyBuffer",
  ].every(name => ownSymbols.some(symbol => symbol.description === name))
    && prototypeSymbols.some(symbol => symbol.description === "window")
}

function isRequestLike(value: AuthRequest): value is Request {
  try {
    const isBrandCheckError = (error: unknown): boolean => {
      if ((typeof error !== "object" && typeof error !== "function") || error === null) return false
      // A caller-controlled object can imitate the name and message of a
      // Web-IDL exception. Require an actual Error value as well; this remains
      // safe across realms because Object#toString uses the Error brand.
      try {
        if (Object.prototype.toString.call(error) !== "[object Error]") return false
      }
      catch {
        return false
      }
      let name: unknown
      let message: unknown
      try {
        name = Reflect.get(error, "name")
        message = Reflect.get(error, "message")
      }
      catch {
        return false
      }
      return name === "TypeError"
        && typeof message === "string"
        && /illegal invocation|invalid (this|receiver)|brand|cannot read properties of (?:null|undefined)|must be (?:an? )?instance/i.test(message)
    }
    // Independent Fetch implementations do not share native brands or prototype
    // layouts. This checks the API used by Better Auth, not the object's origin:
    // host-provided implementations are trusted code, not an authenticity boundary.
    if (Object.prototype.toString.call(value) !== "[object Request]") return false
    const hasPrototypeTag = (target: object, tag: string): boolean => {
      let prototype: object | null = Object.getPrototypeOf(target)
      while (prototype) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag)
        if (descriptor) {
          if (typeof descriptor.get === "function") return descriptor.get.call(target) === tag
          return "value" in descriptor && descriptor.value === tag
        }
        prototype = Object.getPrototypeOf(prototype)
      }
      return false
    }
    const hasBrandedAccessor = (target: object, property: string): boolean => {
      let current: object | null = Object.getPrototypeOf(target)
      while (current) {
        const descriptor = Object.getOwnPropertyDescriptor(current, property)
        if (descriptor) {
          if (typeof descriptor.get !== "function") return false
          try {
            descriptor.get.call(Object.create(null))
            // An invalid receiver must not produce a usable value. Accepting
            // an empty result lets a structural prototype spoof opt out of
            // the brand check and reach Better Auth unchanged.
            if (target !== value) return false
            return hasHappyDomRequestState(value)
          }
          catch (error) {
            if (!isBrandCheckError(error)) return false
            // A genuine Request implementation from another realm or loaded
            // copy reports the same Web-IDL brand failure. Do not tie this
            // compatibility path to Auth's particular Undici constructor.
            return true
          }
        }
        current = Object.getPrototypeOf(current)
      }
      return false
    }
    if (!hasPrototypeTag(value, "Request")) return false
    const hasMethods = (target: object, methods: string[]): boolean => methods.every((method) => {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate capabilities across independent Fetch implementations.
      return typeof Reflect.get(target, method) === "function"
    })
    if (hasHappyDomRequestState(value)) {
      // The private-symbol fingerprint identifies Happy DOM, but still verify
      // the interface Better Auth consumes before preserving the value.
      if (!hasMethods(value, ["clone", "arrayBuffer", "blob", "formData", "json", "text"])) return false
      if (!value.headers || !hasMethods(value.headers, ["get", "has", "set", "append", "delete", "entries", "forEach"])) return false
      if (!value.signal || typeof value.signal.aborted !== "boolean") return false
      return true
    }
    if (!["body", "bodyUsed", "headers", "method", "signal", "url"].every(property => hasBrandedAccessor(value, property))) return false
    if (!hasMethods(value, ["clone", "arrayBuffer", "blob", "formData", "json", "text"])) return false
    // Body methods alone are insufficient: structural host inputs can expose
    // them while lacking the Headers and AbortSignal APIs of a Web Request.
    if (!value.headers || Object.prototype.toString.call(value.headers) !== "[object Headers]" || !hasPrototypeTag(value.headers, "Headers") || !hasMethods(value.headers, ["get", "has", "set", "append", "delete", "entries", "forEach"])) return false
    if (["get", "has", "set", "append", "delete", "entries", "forEach"].some(method => Object.prototype.hasOwnProperty.call(value.headers, method))) return false
    const headersGet = Reflect.get(value.headers, "get")
    if (typeof headersGet !== "function") return false
    try {
      headersGet.call(Object.create(null), "")
      return false
    }
    catch (error) {
      if (!isBrandCheckError(error)) return false
    }
    if (!value.signal || Object.prototype.toString.call(value.signal) !== "[object AbortSignal]" || !hasPrototypeTag(value.signal, "AbortSignal") || typeof value.signal.aborted !== "boolean") return false
    if (Object.prototype.hasOwnProperty.call(value.signal, "aborted")) return false
    return true
  }
  catch {
    return false
  }
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return false
  try {
    let prototype = Object.getPrototypeOf(value)
    const seen = new Set<object>()
    while (prototype && !seen.has(prototype)) {
      seen.add(prototype)
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "aborted")
      if (descriptor?.get) {
        return typeof Reflect.apply(descriptor.get, value, []) === "boolean"
      }
      prototype = Object.getPrototypeOf(prototype)
    }
  }
  catch {
    return false
  }
  return false
}

type HeadersInput = ConstructorParameters<typeof Headers>[0]

/** Where Better Auth returns after one sign-in that a guard starts. */
type AuthSignInURLs = Pick<AuthSignInConfiguration, "callbackURL" | "errorCallbackURL">

/**
 * The Headers init of a host request. A Headers-like object without `Symbol.iterator`, from another
 * Fetch implementation, gives its fields through `entries()`, not through its own properties.
 */
function headersInit(headers: AuthRequest["headers"]): HeadersInput {
  const value: unknown = headers
  if (typeof value !== "object" || value === null || typeof Reflect.get(value, Symbol.iterator) === "function") return headers as HeadersInput
  const entries: unknown = Reflect.get(value, "entries")
  if (typeof entries !== "function") return headers as HeadersInput
  // SAFETY: The Headers constructor validates each entry and throws for an invalid one.
  return Array.from(Reflect.apply(entries, value, []) as Iterable<[string, string]>)
}

function toRequest(request: AuthRequest): Request {
  if (request instanceof Request || isRequestLike(request)) return request
  const init: RequestInitWithDuplex = {
    method: request.method,
  }
  // Preserve conversion failures instead of silently dropping authentication
  // headers such as cookies, authorization, or content type.
  init.headers = new Headers(headersInit(request.headers))
  if (isAbortSignalLike(request.signal)) init.signal = request.signal
  if (request.body) {
    init.body = request.body
    init.duplex = "half"
  }
  return new Request(request.url, init)
}

export function createAuthRequestRuntimeOptions(
  definition: AuthDefinition,
  request: Pick<Request, "headers" | "url">,
  event?: ViteHubContext,
): AuthRuntimeOptions {
  return resolveAuthOptions(definition, { request, event, env: envResolverFor(definition) }).requestRuntimeOptions
}

export function createAuth(definition: AuthDefinition): ViteHubAuth {
  return withSessionMarker(withClientAddress(betterAuth(createBetterAuthOptions(definition)))) as ViteHubAuth
}

export function createAuthForRequest(
  definition: AuthDefinition,
  request: Pick<Request, "headers" | "url">,
  event?: ViteHubContext,
): ViteHubAuth {
  return withSessionMarker(withClientAddress(betterAuth(resolveAuthOptions(definition, { request, event, env: envResolverFor(definition) }).providerOptions))) as ViteHubAuth
}

export function handleAuthRequest(
  definition: AuthDefinition,
  input: AuthRequestInput,
  event: ViteHubContext = authRequestEvent(input),
): Promise<Response> {
  const request = unwrapAuthRequest(input)
  // Better Auth limits requests per client IP. It gets the address that the host reports for the request.
  const address = eventClientAddress(event)
  const auth = requestProvider(definition, resolveAuthOptions(definition, { request, event, env: envResolverFor(definition) }))
  return auth.handler(setRequestClientAddress(toRequest(request), address))
}

/** Return a Web Request itself, or the request in the Standard Context of a request event. */
export function toAuthRequest(input: AuthRequestInput): AuthRequest {
  return unwrapAuthRequest(input)
}

/** Create a handler whose optional host context supplies the peer address, never a client-sent header. */
export function createAuthHandler(definition: AuthDefinition) {
  const auth = createAuth(definition)
  return (request: Request, host?: { clientAddress?: string }): Promise<Response> =>
    auth.handler(setRequestClientAddress(request, host?.clientAddress))
}

export function getAuth(): RegisteredAuth {
  return getAuthForDefinition(resolveDefaultDefinition()) as RegisteredAuth
}

/**
 * Return the Better Auth instance of the app's Auth Definition for a request event or a Web `Request`.
 * The generated types give it the endpoints and fields of the Definition's plugins, so `useAuth(event).api.banUser`
 * type-checks when `server/auth.ts` uses `admin()`.
 */
export function useAuth(event: AuthRequestInput): RegisteredAuth {
  return authForRequest(unwrapAuthRequest(event), authRequestEvent(event))
}

export async function assertAuthOrigin(
  request: Pick<Request, "headers" | "url">,
  event?: ViteHubContext,
): Promise<RegisteredAuth> {
  const origin = request.headers.get("origin")
  if (!origin) throw authErrorDiagnostics.AUTH_R0006({ message: "The request origin is required." })
  const auth = authForRequest(request, event)
  if (!(await auth.$context).isTrustedOrigin(origin)) {
    throw authErrorDiagnostics.AUTH_R0007({ message: "The request origin is not trusted." })
  }
  return auth
}

export function handleAuth(input: AuthRequestInput): Promise<Response> {
  return handleAuthRequest(resolveDefaultDefinition(), input)
}

function wantsHtml(request: Pick<Request, "headers" | "method">): boolean {
  return request.method === "GET" && request.headers.get("accept")?.includes("text/html") === true
}

/** The stable code of an Auth refusal, in `data.code` of the error body. */
type AuthRefusalCode = "SIGNED_OUT" | "FORBIDDEN"

// The inline guards read the code of a text refusal from here, so their HTTPError carries it too.
const refusalCodes = new WeakMap<Response, AuthRefusalCode>()

function refusal(response: Response, code: AuthRefusalCode): Response {
  refusalCodes.set(response, code)
  return response
}

/**
 * A refusal in H3's JSON error format, the same body that `requireAuth()` and H3 errors send. The phrase also goes on
 * the status line.
 */
function createRefusalResponse(code: AuthRefusalCode): Response {
  const status = code === "SIGNED_OUT" ? 401 : 403
  const statusText = code === "SIGNED_OUT" ? "Unauthorized" : "Forbidden"
  return refusal(Response.json({ status, statusText, message: `${statusText}.`, data: { code } }, { status, statusText }), code)
}

/**
 * A text 403 for an HTML request. The phrase on the status line is also the `statusText` of the error that the inline
 * guards throw.
 */
function createTextRefusalResponse(text: string, code: AuthRefusalCode): Response {
  return refusal(new Response(text, {
    headers: { "content-type": "text/plain; charset=utf-8" },
    status: 403,
    statusText: "Forbidden",
  }), code)
}

function createForbiddenResponse(request: Pick<Request, "headers" | "method">): Response {
  return wantsHtml(request)
    ? createTextRefusalResponse("Forbidden.", "FORBIDDEN")
    : createRefusalResponse("FORBIDDEN")
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

// Every guard of one request shares one session lookup. Like reusableAccessChecks, the key is the Request of the
// Standard Context, so H3 middleware, the Fetchable route, and handler guards of one request share it.
const sessionReads = new WeakMap<object, WeakMap<AuthDefinition, Promise<AuthenticationSessionSnapshot | null>>>()

async function readRequestSession(input: AuthRequestInput, definition: AuthDefinition) {
  const request = unwrapAuthRequest(input)
  const resolved = resolveAuthOptions(definition, { request, event: authRequestEvent(input), env: envResolverFor(definition) })
  const auth = requestProvider(definition, resolved)
  let reads = sessionReads.get(request)
  if (!reads) sessionReads.set(request, reads = new WeakMap())
  let session = reads.get(definition)
  if (!session) reads.set(definition, session = getAuthenticationSession(auth, { headers: request.headers }))
  return { auth, options: resolved.options, request, session: await session }
}

type AuthCheck =
  | { authorization: AuthAuthorization, response?: undefined }
  | { authorization?: undefined, response: Response }

function reject(response: Response): AuthCheck {
  return { response }
}


const nativeResponseClone = Object.getOwnPropertyDescriptor(Response.prototype, "clone")?.value

/**
 * A Response of this runtime with an own `then` would be assimilated as a thenable by the host that awaits it.
 * Send a native clone instead, so the rejection still reaches the client as a Response.
 */
function sendableRuntimeResponse(value: Response, request: Pick<Request, "headers" | "method">): Response {
  if (!Object.prototype.hasOwnProperty.call(value, "then")) return value
  try {
    return nativeResponseClone ? Reflect.apply(nativeResponseClone, value, []) : createForbiddenResponse(request)
  }
  catch {
    return createForbiddenResponse(request)
  }
}

const nativePromiseThen = Object.getOwnPropertyDescriptor(Promise.prototype, "then")?.value
const nativePromiseResolve = Promise.resolve

function hasNativePromiseBrand(value: object): boolean {
  if (!nativePromiseThen) return false
  // Object#toString is cross-realm safe for ordinary promises, while walking
  // the chain also recognizes same-realm promises whose toStringTag or then
  // method has been shadowed. Plain thenables never inherit Promise.prototype.
  try {
    let prototype = Object.getPrototypeOf(value)
    const seen = new Set<object>()
    while (prototype && !seen.has(prototype)) {
      seen.add(prototype)
      if (Object.prototype.hasOwnProperty.call(prototype, "then")
        && Object.getOwnPropertyDescriptor(prototype, "then")?.value === nativePromiseThen) return true
      prototype = Object.getPrototypeOf(prototype)
    }
    // A promise from another realm has a different Promise.prototype.then,
    // and its tag may be shadowed. The intrinsic then brand check is the
    // remaining realm-independent way to recognize it. Use no-op handlers so
    // a rejected source promise is observed while probing.
    const valueDescriptor = Object.getOwnPropertyDescriptor(value, "constructor")
    let valueOverridden = false
    try {
      if (!valueDescriptor || valueDescriptor.configurable) {
        Object.defineProperty(value, "constructor", { configurable: true, writable: true, value: Promise })
        valueOverridden = true
      }
      else if ("value" in valueDescriptor && valueDescriptor.writable) {
        Object.defineProperty(value, "constructor", { value: Promise })
        valueOverridden = true
      }
    } catch { /* intrinsic probe below will reject non-promises */ }
    let probe: unknown
    try {
      probe = Reflect.apply(nativePromiseThen, value, [() => undefined, () => undefined])
    }
    finally {
      if (valueOverridden) {
        if (valueDescriptor) Object.defineProperty(value, "constructor", valueDescriptor)
        else Reflect.deleteProperty(value, "constructor")
      }
    }
    // Consume the derived promise without creating another species-derived
    // rejection. Shadow its constructor while it is configurable, then the
    // intrinsic call returns a native promise whose own cleanup is safe.
    if (probe && (typeof probe === "object" || typeof probe === "function")) {
      const descriptor = Object.getOwnPropertyDescriptor(probe, "constructor")
      let overridden = false
      try {
        if (!descriptor || descriptor.configurable) {
          Object.defineProperty(probe, "constructor", { configurable: true, writable: true, value: Promise })
          overridden = true
        }
        else if ("value" in descriptor && descriptor.writable) {
          Object.defineProperty(probe, "constructor", { value: Promise })
          overridden = true
        }
        const cleanup = Reflect.apply(nativePromiseThen, probe, [() => undefined, () => undefined])
        if (cleanup && (typeof cleanup === "object" || typeof cleanup === "function")) {
          // The first cleanup call returns a promise too. Consume that result
          // while forcing native construction, so hostile species cannot leave
          // a rejected derived promise unhandled.
          const cleanupDescriptor = Object.getOwnPropertyDescriptor(cleanup, "constructor")
          let cleanupOverridden = false
          try {
            if (!cleanupDescriptor || cleanupDescriptor.configurable) {
              Object.defineProperty(cleanup, "constructor", { configurable: true, writable: true, value: Promise })
              cleanupOverridden = true
            }
            else if ("value" in cleanupDescriptor && cleanupDescriptor.writable) {
              Object.defineProperty(cleanup, "constructor", { value: Promise })
              cleanupOverridden = true
            }
            const cleanupResult = Reflect.apply(nativePromiseThen, cleanup, [() => undefined, () => undefined])
            // This final result is native by construction and its no-op
            // handlers ensure any rejection is observed.
            if (cleanupResult && (typeof cleanupResult === "object" || typeof cleanupResult === "function")) {
              const finalCleanup = Reflect.apply(nativePromiseThen, cleanupResult, [() => undefined, () => undefined])
              // Keep the final derived promise reachable until its handlers
              // are installed. Native construction above makes this call
              // species-safe, so no further adoption is required.
              void finalCleanup
            }
          }
          finally {
            if (cleanupOverridden) {
              if (cleanupDescriptor) Object.defineProperty(cleanup, "constructor", cleanupDescriptor)
              else Reflect.deleteProperty(cleanup, "constructor")
            }
          }
        }
      }
      finally {
        if (overridden) {
          if (descriptor) Object.defineProperty(probe, "constructor", descriptor)
          else Reflect.deleteProperty(probe, "constructor")
        }
      }
    }
    return true
  }
  catch {
    return false
  }
  return false
}

/**
 * Only `true` grants access. A Response of this runtime is sent as the rejection. Every other value gets `deny()`, `403` by default.
 */
async function runAccessAuthorize<TContext extends Pick<AuthAccessAuthorizationContext, "request">>(
  authorize: (context: TContext) => unknown,
  context: TContext,
  deny: () => Response = () => createForbiddenResponse(context.request),
): Promise<{ response?: Response }> {
  const result: unknown = authorize(context)
  // Check for a Response before any thenable handling. A Response may expose an own `then` property, but it must
  // still be treated as a Response rather than assimilated as a promise.
  if (isRuntimeResponse(result)) return { response: sendableRuntimeResponse(result, context.request) }

  let resolved: unknown
  if (result !== null && (typeof result === "object" || typeof result === "function")
    && hasNativePromiseBrand(result)) {
    // Promise.prototype.then performs the intrinsic Promise brand check and
    // bypasses an overridden `then` method on Promise subclasses. Plain
    // thenables fail that check and fall back to normal await semantics below.
    let nativePromise: Promise<unknown> | undefined
    let constructorDescriptor: PropertyDescriptor | undefined
    let speciesDescriptor: PropertyDescriptor | undefined
    let speciesOverridden = false
    let constructorOverridden = false
    try {
      // Shadow an inherited constructor so intrinsic `then` uses the native
      // Promise constructor instead of consulting a throwing Symbol.species.
      constructorDescriptor = Object.getOwnPropertyDescriptor(result, "constructor")
      if (!constructorDescriptor || constructorDescriptor.configurable) {
        Object.defineProperty(result, "constructor", { configurable: true, writable: true, value: Promise })
        constructorOverridden = true
      }
      else if (typeof constructorDescriptor.value === "function") {
        speciesDescriptor = Object.getOwnPropertyDescriptor(constructorDescriptor.value, Symbol.species)
        if (!speciesDescriptor || speciesDescriptor.configurable) {
          Object.defineProperty(constructorDescriptor.value, Symbol.species, { configurable: true, value: Promise })
          speciesOverridden = true
        }
        else if ("value" in constructorDescriptor && constructorDescriptor.writable) {
          // A non-configurable own constructor can still be replaced when its
          // data slot is writable. This avoids consulting a hostile species
          // getter while preserving the descriptor and value afterwards.
          Object.defineProperty(result, "constructor", { value: Promise })
          constructorOverridden = true
        }
      }
      nativePromise = new Promise((resolve, reject) => {
        // Use a native promise as the adoption target. The returned derived
        // promise may reject because of a hostile species constructor, but
        // the source callbacks still observe the original settlement.
        Promise.prototype.then.call(result, resolve, reject)
      })
    }
    catch (error) {
      try {
        // Native resolution adopts the source without creating a species
        // derived promise, so immutable species descriptors cannot hide the
        // source settlement.
        nativePromise = Reflect.apply(nativePromiseResolve, Promise, [result])
      }
      catch {
        nativePromise = Promise.reject(error)
      }
    }
    finally {
      if (constructorOverridden) {
        if (constructorDescriptor) Object.defineProperty(result, "constructor", constructorDescriptor)
        else Reflect.deleteProperty(result, "constructor")
      }
      if (speciesOverridden && constructorDescriptor && typeof constructorDescriptor.value === "function") {
        if (speciesDescriptor) Object.defineProperty(constructorDescriptor.value, Symbol.species, speciesDescriptor)
        else Reflect.deleteProperty(constructorDescriptor.value, Symbol.species)
      }
    }
    // If species construction is completely unreplaceable, the probe above
    // has still observed the source settlement. Do not await the original
    // value here: that would dispatch its mutable/species-sensitive `then`
    // again and can rethrow a hostile species error.
    resolved = nativePromise ? await nativePromise : undefined
  }
  else {
    resolved = result !== null && (typeof result === "object" || typeof result === "function")
      ? await result
      : result
  }
  if (resolved === true) return {}
  if (isRuntimeResponse(resolved)) return { response: sendableRuntimeResponse(resolved, context.request) }
  return { response: deny() }
}

async function checkAuthRequest(
  input: AuthRequestInput,
  definition: AuthDefinition,
  routeIndexes?: number[],
  requiredAuthorizeRouteIndexes: number[] = [],
  redirectToSignIn = true,
  resolveIdentity?: AuthAccessIdentityResolver,
  signInURLs?: AuthSignInURLs,
): Promise<AuthCheck> {
  const { auth, options, request, session } = await readRequestSession(input, definition)
  const identity = await resolveIdentity?.(toRequest(request), input, Boolean(session))
  if (isRuntimeResponse(identity)) return reject(identity)
  if (identity || session) {
    const authorization: AuthAuthorization = Object.freeze({
      request,
      session: identity ? {} : session!.session,
      user: identity ?? session!.user,
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
      if (rejection.response) return reject(rejection.response)
    }
    return { authorization }
  }

  if (!wantsHtml(request)) {
    return reject(createRefusalResponse("SIGNED_OUT"))
  }

  if (!redirectToSignIn) {
    return reject(createRefusalResponse("SIGNED_OUT"))
  }

  if (new URL(request.url).searchParams.has("auth_error")) {
    return reject(createTextRefusalResponse("Unauthorized.", "SIGNED_OUT"))
  }

  const signIn = (options as { access?: AuthAccessConfiguration }).access?.signIn
  return reject(signIn
    ? await createSignInResponse(auth, options, { ...signIn, ...signInURLs })
    : createRefusalResponse("SIGNED_OUT"))
}

async function checkAuthorizeRequest(
  input: AuthRequestInput,
  authorize: AccessAuthorizeOption,
  definition: AuthDefinition,
): Promise<AuthCheck> {
  const { request, session } = await readRequestSession(input, definition)
  if (!session) return reject(createRefusalResponse("SIGNED_OUT"))
  const authorization: AuthAuthorization = Object.freeze({ request, session: session.session, user: session.user })
  if (authorize === true) return { authorization }
  const rejection = await runAccessAuthorize(authorize, authorization)
  return rejection.response ? reject(rejection.response) : { authorization }
}

/**
 * Like `withAuthorization()`, but a signed-out caller also reaches `authorize`, with `session` and `user` set to `null`.
 * Use it for resources that a signed-out caller can open, such as files shared by public link.
 * `false` returns `401` for a signed-out caller and `403` for a signed-in one. It never redirects to sign-in.
 */
export function withAnonymousAuthorization<TInput extends AuthRequestInput, TResult>(
  authorize: AuthAnonymousAuthorize,
  handler: AuthAnonymousGuardedHandler<TInput, TResult>,
  definition?: AuthDefinition,
): (input: TInput) => Promise<TResult | Response> {
  if (typeof authorize !== "function") {
    throw authErrorDiagnostics.AUTH_R0014({ message: "[vitehub] `authorize` must be a function." })
  }
  if (typeof handler !== "function") {
    throw authErrorDiagnostics.AUTH_R0015({ message: "[vitehub] withAnonymousAuthorization() requires a handler function." })
  }
  return async (input) => {
    const { request, session } = await readRequestSession(input, definition ?? resolveDefaultDefinition())
    const authorization: AuthAuthorization | AuthAnonymousAuthorization = session
      ? Object.freeze({ request, session: session.session, user: session.user })
      : Object.freeze({ request, session: null, user: null })
    // `false` keeps the status that withAuthorization() returns for the same caller.
    const deny = session ? undefined : () => createRefusalResponse("SIGNED_OUT")
    const rejection = await runAccessAuthorize(authorize, authorization, deny)
    if (rejection.response) return rejection.response
    return handler(input, authorization)
  }
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

/**
 * The `HTTPError` that an inline guard throws for a rejection `Response`. It keeps the status and headers, such as
 * `location` and `set-cookie` of a sign-in redirect. JSON object fields stay in the error body; other JSON values
 * become `data`. Text becomes the error message, with H3's JSON content type.
 */
async function rejectionError(response: Response): Promise<HTTPError> {
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  const isJson = headers.get("content-type")?.toLowerCase().includes("json") === true
  if (!isJson) headers.delete("content-type")
  const text = await response.text()
  let body: unknown
  if (isJson) {
    try {
      body = JSON.parse(text)
    }
    catch { /* Keep a malformed JSON response as the error message. */ }
  }
  const jsonBody = body !== null && typeof body === "object" && !Array.isArray(body) ? { ...body } : undefined
  let message = typeof body === "string" ? body : body === undefined ? text : undefined
  if (body !== null && typeof body === "object") {
    if ("error" in body && typeof body.error === "string") message = body.error
    else if ("message" in body && typeof body.message === "string") message = body.message
  }
  const code = refusalCodes.get(response)
  return new HTTPError({
    body: jsonBody,
    data: code ? { code } : jsonBody === undefined ? body : undefined,
    headers,
    message: message || undefined,
    status: response.status,
    statusText: response.statusText || undefined,
  })
}

async function requireCheck(check: Promise<AuthCheck>): Promise<AuthAuthorization> {
  const result = await check
  if (result.response) throw await rejectionError(result.response)
  return result.authorization
}

/**
 * Return the checked request, Session, and user of a signed-in caller, or throw an `HTTPError`.
 * It rejects like `withAuth()`: `401`, or the `access.signIn` redirect for an HTML request.
 *
 * ```ts [server/api/profile.get.ts]
 * export default defineHandler(async (event) => {
 *   const { user } = await requireAuth(event)
 *   return { id: user.id }
 * })
 * ```
 */
export function requireAuth(event: AuthRequestInput, definition?: AuthDefinition): Promise<AuthAuthorization> {
  return requireCheck(checkAuthRequest(event, definition ?? resolveDefaultDefinition()))
}

/**
 * Return the checked request, Session, and user after `authorize` accepts the request, or throw an `HTTPError`.
 * It rejects like `withAuthorization()`: `401` without a session, `403` when `authorize` returns `false`, or the
 * status and headers of the callback's `Response`. It never redirects to sign-in.
 */
export function requireAuthorization(
  event: AuthRequestInput,
  authorize: AccessAuthorizeOption,
  definition?: AuthDefinition,
): Promise<AuthAuthorization> {
  if (authorize !== true && typeof authorize !== "function") {
    throw authErrorDiagnostics.AUTH_R0014({ message: "[vitehub] `authorize` must be true or a function." })
  }
  return requireCheck(checkAuthorizeRequest(event, authorize, definition ?? resolveDefaultDefinition()))
}

// One session read per request, however many abilities the handler checks.
const abilitySessions = new WeakMap<object, Promise<AuthAuthorization | AuthAnonymousAuthorization>>()

function readAbilityAuthorization(input: AuthRequestInput): Promise<AuthAuthorization | AuthAnonymousAuthorization> {
  let pending = abilitySessions.get(input)
  if (!pending) {
    pending = readRequestSession(input, resolveDefaultDefinition()).then(({ request, session }) => session
      ? Object.freeze({ request, session: session.session, user: session.user })
      : Object.freeze({ request, session: null, user: null }))
    // A failed read is not kept, so a later check reads again.
    pending.catch(() => abilitySessions.delete(input))
    abilitySessions.set(input, pending)
  }
  return pending
}

/**
 * Checks a rule from `shared/abilities.ts` for the caller of a request. Returns the checked request, session, and user.
 * Throws an `AbilityError` when the rule refuses: `401` for a signed-out caller, else `403` or the status of `deny()`.
 *
 * @example
 * const post = await getPost(id)
 * const { user } = await requireAbility(event, "posts.edit", post)
 */
export async function requireAbility<const Name extends AbilityName>(
  event: AuthRequestInput,
  name: Name,
  ...args: AbilityArgs<Name>
): Promise<AbilityAuthorization<Name>> {
  const authorization = await readAbilityAuthorization(event)
  const refusal = checkAbility(abilities, authorization.user, name, args)
  if (refusal) throw new AbilityError(refusal)
  // SAFETY: the rule allowed the caller. Only a `guest()` rule allows a signed-out caller, which the type includes.
  return authorization as AbilityAuthorization<Name>
}

/**
 * Whether a rule from `shared/abilities.ts` allows the caller of a request.
 *
 * @example
 * const editable = await can(event, "posts.edit", post)
 */
export async function can<const Name extends AbilityName>(event: AuthRequestInput, name: Name, ...args: AbilityArgs<Name>): Promise<boolean> {
  const authorization = await readAbilityAuthorization(event)
  return checkAbility(abilities, authorization.user, name, args) === null
}

// Middleware records success for an opted-in guard; that guard also lets later middleware reuse its check. The key is
// the Request of the Standard Context, so an H3 middleware and the Fetchable route of one request share the check.
const reusableAccessChecks = new WeakMap<object, WeakMap<AuthDefinition, Map<string, boolean>>>()

async function checkAuthAccessRequest(
  input: AuthRequestInput,
  definition: AuthDefinition,
  routeIndexes: number[],
  requiredAuthorizeRouteIndexes: number[],
  options: { redirectToSignIn?: boolean, reuse?: boolean, remember?: boolean, signIn?: AuthSignInURLs } = {},
): Promise<Response | undefined> {
  const key = JSON.stringify([routeIndexes, requiredAuthorizeRouteIndexes])
  const request = unwrapAuthRequest(input)
  let definitions = reusableAccessChecks.get(request)
  let accepted = definitions?.get(definition)
  const reusable = accepted?.get(key)
  if (reusable === true || (options.reuse && reusable === false)) return
  const { response } = await checkAuthRequest(input, definition, routeIndexes, requiredAuthorizeRouteIndexes, options.redirectToSignIn !== false, getAuthRuntimeState().accessIdentityResolvers?.get(new URL(request.url).pathname), options.signIn)
  if (!response && (options.reuse || options.remember)) {
    if (!definitions) reusableAccessChecks.set(request, definitions = new WeakMap())
    if (!accepted) definitions.set(definition, accepted = new Map())
    accepted.set(key, options.reuse === true)
  }
  return response
}

/** Bind discovered access routes to a Web Request or host request handler. */
export function createAuthAccessHandler(
  routes: readonly ResolvedAuthAccessRoute[],
  definition?: AuthDefinition,
  publicRoutes: readonly string[] = [],
): (input: AuthRequestInput) => Promise<Response | undefined> {
  const match = createAuthAccessRouteMatcher(routes, publicRoutes)

  return async (input) => {
    const matched = match(input)
    if (matched.length === 0) return

    return await checkAuthAccessRequest(
      input,
      definition ?? resolveDefaultDefinition(),
      matched.map(rule => rule.index),
      matched.filter(rule => rule.authorize).map(rule => rule.index),
      { remember: true },
    )
  }
}

export async function requireAuthAccessRoutes(
  input: AuthRequestInput,
  routeIndexes: number[],
  definition: AuthDefinition = resolveDefaultDefinition(),
  requiredAuthorizeRouteIndexes: number[] = [],
  options: {
    redirectToSignIn?: boolean
    /** Where Better Auth returns after this sign-in, replacing `access.signIn.callbackURL` and `errorCallbackURL`. */
    signIn?: AuthSignInURLs
    /** Reuse successful checks of these exact rules and Definition on this request, including in app Auth middleware. */
    reuse?: boolean
  } = {},
): Promise<Response | undefined> {
  if (!Array.isArray(routeIndexes) || routeIndexes.length === 0 || routeIndexes.some(routeIndex => !Number.isSafeInteger(routeIndex) || routeIndex < 0)) {
    throw authErrorDiagnostics.AUTH_R0009({ message: "[vitehub] Auth access route indexes must be a non-empty array of non-negative integers." })
  }
  if (!Array.isArray(requiredAuthorizeRouteIndexes) || requiredAuthorizeRouteIndexes.some(routeIndex => !Number.isSafeInteger(routeIndex) || routeIndex < 0)) {
    throw authErrorDiagnostics.AUTH_R0010({ message: "[vitehub] Required Auth authorize route indexes must be an array of non-negative integers." })
  }
  return await checkAuthAccessRequest(input, definition, routeIndexes, requiredAuthorizeRouteIndexes, options)
}

/**
 * The Auth route that ViteHub mounts at `/api/auth/**`, as a Fetchable. It reads the client address and the
 * Cloudflare bindings from the Standard Context of the Request.
 */
const authRoute = {
  fetch(request: Request): Promise<Response> {
    return handleAuth(request)
  },
}

export default authRoute

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
}) as RegisteredAuth

/** Read the configured log from server code. Apply access checks before returning it to a caller. */
export function getAuthEvents(definition: AuthDefinition = resolveDefaultDefinition(), request?: Pick<Request, "headers" | "url">): AuthEventStore | undefined {
  const events = resolveAuthOptions(definition, { request, env: envResolverFor(definition) }).options.events
  return events ? events.store : undefined
}

export async function listAuthEvents(input: AuthEventListInput = {}, definition?: AuthDefinition): Promise<AuthEventPage> {
  const store = getAuthEvents(definition)
  if (!store) throw authErrorDiagnostics.AUTH_R0018({ message: "Auth events are disabled. Configure events.store in defineAuth()." })
  return store.list(input)
}

export async function aggregateAuthEvents(window: AuthEventWindow, definition?: AuthDefinition): Promise<AuthEventAggregates> {
  const store = getAuthEvents(definition)
  if (!store) throw authErrorDiagnostics.AUTH_R0018({ message: "Auth events are disabled. Configure events.store in defineAuth()." })
  return store.aggregate(window)
}

/**
 * Resolve the primary Definition once, with the same request context for the provider and Console policy.
 * `host.impersonation` lets the Console start impersonation. It is off by default.
 */
export function getAuthConsoleForRequest(request: Request, event?: ViteHubContext, host?: AuthConsoleHostOptions): AuthConsole {
  const definition = resolveDefaultDefinition()
  const resolved = resolveAuthOptions(definition, {
    request,
    event,
    env: envResolverFor(definition),
  });
  return createAuthConsole(
    requestProvider(definition, resolved),
    resolved.options.console as AuthConsoleOptions | undefined,
    resolved.options.events ? resolved.options.events.store : undefined,
    host,
  );
}
