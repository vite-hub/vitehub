import { createAuthConsole, type AuthConsole } from "./console-runtime.ts";
import type { AuthConsoleOptions } from "./console-types.ts";
import discoveredDefinition from "#vitehub/auth/definition"
import { defineGrant } from "@vite-hub/runtime/internal/grant"
import { betterAuth } from "better-auth"
import { resolveAuthMountPath } from "./application-path.ts"
import { normalizeAuthBasePath } from "./shared.ts"
import { unwrapAuthRequest } from "./request.ts"
import { resolveAuthOptions } from "./runtime-options.ts"
import { throwAuthenticationProviderError } from "./errors.ts"
import { getAuthenticationSession } from "./session.ts"
import { getAuthRuntimeState } from "./runtime-state.ts"
import { withSessionMarker } from "./session-marker.ts"

import type { AuthEventAggregates, AuthEventListInput, AuthEventPage, AuthEventStore, AuthEventWindow } from "./events.ts"
import type { AuthAccessIdentityResolver, AuthRuntimeEnvResolver } from "./runtime-state.ts"
import type { AccessAuthorizeOption, PublicUrlConfig } from "@vite-hub/runtime"
import type {
  AuthAccessAuthorize,
  AuthAccessConfiguration,
  AuthAccessAuthorizationContext,
  AuthAccessRoute,
  AuthAuthorization,
  AuthBetterAuthRuntimeOptions,
  AuthDefinition,
  AuthFor,
  AuthGuardedHandler,
  AuthMiddleware,
  AuthRequest,
  AuthRequestInput,
  AuthRuntimeOptions,
  AuthSignInConfiguration,
  RegisteredAuth,
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



export function setAuthRuntimeEnvResolver(resolver: AuthRuntimeEnvResolver | undefined, definition?: AuthDefinition): void {
  const state = getAuthRuntimeState()
  if (definition) state.envResolvers?.set(definition as object, resolver as AuthRuntimeEnvResolver)
  else state.envResolver = resolver
}

function envResolverFor(definition: AuthDefinition): AuthRuntimeEnvResolver | undefined {
  return getAuthRuntimeState().envResolvers?.get(definition as object) ?? getAuthRuntimeState().envResolver}

interface RequestInitWithDuplex extends RequestInit {
  duplex?: "half"
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
            const ownSymbols = Object.getOwnPropertySymbols(value)
            const prototypeSymbols = Object.getOwnPropertySymbols(Object.getPrototypeOf(value) ?? {})
            // Happy DOM stores its Request state in a fixed set of private
            // symbols. Require the complete state shape before accepting an
            // implementation whose accessors do not expose a Web-IDL brand
            // error. A caller-created lookalike with a few arbitrary symbols
            // must stay on the normalization path.
            const happyDomSymbols = [
              "method", "body", "mode", "headers", "redirect", "referrerPolicy",
              "signal", "bodyUsed", "credentials", "aborted", "error", "contentLength",
              "contentType", "referrer", "url", "bodyBuffer",
            ]
            const happyDomState = happyDomSymbols.every(name =>
              ownSymbols.some(symbol => symbol.description === name),
            )
              && prototypeSymbols.some(symbol => symbol.description === "window")
            if (!happyDomState) return false
            return true
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
    const ownSymbols = Object.getOwnPropertySymbols(value)
    const prototypeSymbols = Object.getOwnPropertySymbols(Object.getPrototypeOf(value) ?? {})
    const happyDomState = [
      "method", "body", "mode", "headers", "redirect", "referrerPolicy",
      "signal", "bodyUsed", "credentials", "aborted", "error", "contentLength",
      "contentType", "referrer", "url", "bodyBuffer",
    ].every(name => ownSymbols.some(symbol => symbol.description === name))
      && prototypeSymbols.some(symbol => symbol.description === "window")
    if (happyDomState) {
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
  runtimeOptions: AuthRuntimeOptions = {},
  event?: unknown,
): AuthRuntimeOptions {


  return resolveAuthOptions(definition, { request, runtimeOptions, event, env: envResolverFor(definition) }).requestRuntimeOptions}

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


  return resolveAuthOptions(definition, { runtimeOptions, env: envResolverFor(definition) }).providerOptions}

function createAuthenticationProvider<TAuth = ViteHubAuth>(options: AuthBetterAuthRuntimeOptions): TAuth {
  try {
    // SAFETY: callers pass the options of the Auth Definition that TAuth is inferred from.
    return withSessionMarker(betterAuth(options)) as TAuth
  }
  catch (cause) {
    throwAuthenticationProviderError(cause, "get-auth-for-request")
  }
}

export function createAuth(
  definition: AuthDefinition,
  runtimeOptions?: AuthRuntimeOptions,
): ViteHubAuth {
  return withSessionMarker(betterAuth(createBetterAuthOptions(definition, runtimeOptions))) as ViteHubAuth
}

export function createAuthForRequest(
  definition: AuthDefinition,
  request: Pick<Request, "headers" | "url">,
  runtimeOptions?: AuthRuntimeOptions,
  event?: unknown,
): ViteHubAuth {


  return withSessionMarker(betterAuth(resolveAuthOptions(definition, { request, runtimeOptions, event, env: envResolverFor(definition) }).providerOptions)) as ViteHubAuth}

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

export function getAuthForDefinition<TDefinition extends AuthDefinition>(
  definition: TDefinition,
  runtimeOptions?: AuthRuntimeOptions,
): AuthFor<TDefinition> {
  if (hasRuntimeOptions(runtimeOptions)) {
    return createAuthenticationProvider<AuthFor<TDefinition>>(createBetterAuthOptions(definition, runtimeOptions))
  }

  return cachedAuth(definition)
}

function cachedAuth<TAuth>(definition: AuthDefinition): TAuth {
  const state = getAuthRuntimeState()
  if (!state.auth || state.definition !== definition) {
    state.auth = createAuthenticationProvider(createBetterAuthOptions(definition))
    state.definition = definition
  }
  // SAFETY: state.auth is the instance of `definition`, the Auth Definition that TAuth is inferred from.
  return state.auth as TAuth
}

export function getAuth(runtimeOptions?: AuthRuntimeOptions): RegisteredAuth {
  return getAuthForDefinition(resolveDefaultDefinition(), runtimeOptions) as RegisteredAuth
}

/** Return the Better Auth instance of the app's Auth Definition, typed with its plugins by the generated types. */
export function getAuthForRequest(
  request: Pick<Request, "headers" | "url">,
  runtimeOptions?: AuthRuntimeOptions,
  event?: unknown,
): RegisteredAuth {
  const definition = resolveDefaultDefinition()
  if (!hasRequestRuntimeOptions(definition) && !hasRuntimeOptions(runtimeOptions) && !hasConfiguredPublicUrl()) {
    return getAuthForDefinition(definition) as RegisteredAuth
  }


  return createAuthenticationProvider(resolveAuthOptions(definition, { request, runtimeOptions, event, env: envResolverFor(definition) }).providerOptions)}

export async function assertAuthOrigin(
  request: Pick<Request, "headers" | "url">,
  event?: unknown,
): Promise<RegisteredAuth> {
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


  const { options, providerOptions } = resolveAuthOptions(definition, { request, event: input, env: envResolverFor(definition) })
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
const nativeResponseClone = Object.getOwnPropertyDescriptor(Response.prototype, "clone")?.value

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
 * Only `true` grants access. A Response of this runtime is sent as the rejection. Every other value gets `403`.
 */
async function runAccessAuthorize(
  authorize: AuthAccessAuthorize,
  context: AuthAccessAuthorizationContext,
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
  return { response: createForbiddenResponse(context.request) }
}

async function checkAuthRequest(
  input: AuthRequestInput,
  definition: AuthDefinition,
  routeIndexes?: number[],
  requiredAuthorizeRouteIndexes: number[] = [],
  redirectToSignIn = true,
  resolveIdentity?: AuthAccessIdentityResolver,
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

// The middleware attaches this grant to the event. Only getAuthorization() reads it, so other code cannot set it.
const authorizationGrant = defineGrant("vitehub.auth.authorization", (authorization: AuthAuthorization) => authorization)

function authMiddleware(check: (event: AuthRequestInput) => Promise<AuthCheck>): AuthMiddleware {
  return async (event, next) => {
    const result = await check(event)
    if (result.response) return result.response
    authorizationGrant.attach(event, authorizationGrant.issue(result.authorization))
    return next()
  }
}

/**
 * Route middleware for H3 2 that lets the request continue only with a signed-in Auth Session.
 * It rejects like `withAuth()`: `401`, or the `access.signIn` redirect for HTML requests.
 * The route handler reads the checked authorization with `getAuthorization(event)`.
 */
export function requireAuth(definition?: AuthDefinition): AuthMiddleware {
  return authMiddleware(event => checkAuthRequest(event, definition ?? resolveDefaultDefinition()))
}

/**
 * Route middleware for H3 2 that lets the request continue only after `authorize` accepts it.
 * It rejects like `withAuthorization()`: `401` without a session, `403` when `authorize` returns `false`,
 * or the callback's `Response`. It never redirects to sign-in.
 * The route handler reads the checked authorization with `getAuthorization(event)`.
 */
export function requireAuthorization(
  authorize: AccessAuthorizeOption,
  definition?: AuthDefinition,
): AuthMiddleware {
  if (authorize !== true && typeof authorize !== "function") {
    throw authErrorDiagnostics.AUTH_R0014({ message: "[vitehub] `authorize` must be true or a function." })
  }
  return authMiddleware(event => checkAuthorizeRequest(event, authorize, definition ?? resolveDefaultDefinition()))
}

/**
 * Return the checked request, Session, and user that `requireAuth()` or `requireAuthorization()` attached to `event`.
 * Throws when no Auth middleware accepted this event, so a route without the middleware fails closed.
 */
export function getAuthorization(event: AuthRequestInput): AuthAuthorization {
  const grant = authorizationGrant.attached(event)
  if (!grant) {
    throw authErrorDiagnostics.AUTH_R0017({ message: "[vitehub] getAuthorization() found no checked Auth Session for this event. Add requireAuth() or requireAuthorization() to the route middleware." })
  }
  return authorizationGrant.verify(grant)
}

/**
 * Let a trusted server integration authenticate one exact mounted path without a browser session.
 * Resolved users still pass every matching Auth access route's authorize callback, with an empty session.
 */
export function setAuthAccessIdentityResolver(path: string, resolver: AuthAccessIdentityResolver | undefined): void {
  const state = getAuthRuntimeState()
  state.accessIdentityResolvers ??= new Map()
  if (resolver) state.accessIdentityResolvers.set(path, resolver)
  else state.accessIdentityResolvers.delete(path)
}

// Middleware records success for an opted-in guard; that guard also lets later middleware reuse its check.
const reusableAccessChecks = new WeakMap<object, WeakMap<AuthDefinition, Map<string, boolean>>>()

async function checkAuthAccessRequest(
  input: AuthRequestInput,
  definition: AuthDefinition,
  routeIndexes: number[],
  requiredAuthorizeRouteIndexes: number[],
  options: { redirectToSignIn?: boolean, reuse?: boolean, remember?: boolean } = {},
): Promise<Response | undefined> {
  const key = JSON.stringify([routeIndexes, requiredAuthorizeRouteIndexes])
  let definitions = reusableAccessChecks.get(input)
  let accepted = definitions?.get(definition)
  const reusable = accepted?.get(key)
  if (reusable === true || (options.reuse && reusable === false)) return
  const { response } = await checkAuthRequest(input, definition, routeIndexes, requiredAuthorizeRouteIndexes, options.redirectToSignIn !== false, getAuthRuntimeState().accessIdentityResolvers?.get(new URL(unwrapAuthRequest(input).url).pathname))
  if (!response && (options.reuse || options.remember)) {
    if (!definitions) reusableAccessChecks.set(input, definitions = new WeakMap())
    if (!accepted) definitions.set(definition, accepted = new Map())
    accepted.set(key, options.reuse === true)
  }
  return response
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
    path: (() => {
      const recursive = route.route.endsWith("/**")
      const resolved = resolveAuthMountPath(recursive ? route.route.slice(0, -3) : route.route)
      return recursive ? (resolved === "/" ? "" : resolved.replace(/\/$/, "")) : resolved
    })(),
    recursive: route.route.endsWith("/**"),
  }))

  return async (input) => {
    const request = unwrapAuthRequest(input);
    const pathname = new URL(request.url).pathname;
    const method = request.method.toUpperCase();
    const matched = rules.filter(
      (rule) =>
        (!rule.method || rule.method === method) &&
        (pathname === rule.path || (rule.recursive && (rule.path === "" || pathname.startsWith(`${rule.path}/`)))),
    );
    if (matched.length === 0) return;

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

/** Resolve the primary Definition once, with the same request context for the provider and Console policy. */
export function getAuthConsoleForRequest(request: Request, event?: unknown): AuthConsole {
  const definition = resolveDefaultDefinition()
  const resolved = resolveAuthOptions(definition, {
    request,
    event,
    env: envResolverFor(definition),
  });
  return createAuthConsole(
    createAuthenticationProvider(resolved.providerOptions),
    resolved.options.console as AuthConsoleOptions | undefined,
    resolved.options.events ? resolved.options.events.store : undefined,
  );
}
