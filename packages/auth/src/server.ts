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


export function setAuthRuntimeEnvResolver(resolver: AuthRuntimeEnvResolver | undefined, definition?: AuthDefinition): void {
  const state = getAuthRuntimeState()
  if (definition) state.envResolvers?.set(definition as object, resolver as AuthRuntimeEnvResolver)
  else state.envResolver = resolver
}

function envResolverFor(definition: AuthDefinition): AuthRuntimeEnvResolver | undefined {
  return getAuthRuntimeState().envResolvers?.get(definition as object) ?? getAuthRuntimeState().envResolver
}

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

function toRequest(request: AuthRequest): Request {
  if (request instanceof Request || isRequestLike(request)) return request
  const init: RequestInitWithDuplex = {
    method: request.method,
  }
  // Preserve conversion failures instead of silently dropping authentication
  // headers such as cookies, authorization, or content type.
  init.headers = new Headers(request.headers as ConstructorParameters<typeof Headers>[0])
  if (request.signal instanceof AbortSignal) init.signal = request.signal
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

  return resolveAuthOptions(definition, { request, runtimeOptions, event, env: envResolverFor(definition) }).requestRuntimeOptions
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

  return resolveAuthOptions(definition, { runtimeOptions, env: envResolverFor(definition) }).providerOptions
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

  return betterAuth(resolveAuthOptions(definition, { request, runtimeOptions, event, env: envResolverFor(definition) }).providerOptions) as ViteHubAuth
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

  return createAuthenticationProvider(resolveAuthOptions(definition, { request, runtimeOptions, event, env: envResolverFor(definition) }).providerOptions)
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
const nativeResponseStatusText = Object.getOwnPropertyDescriptor(Response.prototype, "statusText")?.get
const nativeResponseBodyUsed = Object.getOwnPropertyDescriptor(Response.prototype, "bodyUsed")?.get
const nativeResponseHeaders = Object.getOwnPropertyDescriptor(Response.prototype, "headers")?.get
const nativeResponseBody = Object.getOwnPropertyDescriptor(Response.prototype, "body")?.get
const nativeResponseClone = Object.getOwnPropertyDescriptor(Response.prototype, "clone")?.value
const nativeHeadersForEach = Object.getOwnPropertyDescriptor(Headers.prototype, "forEach")?.value
const nativeHeadersGet = Object.getOwnPropertyDescriptor(Headers.prototype, "get")?.value

/**
 * Return whether `value` is a Response of this runtime.
 * The native `status` getter checks the internal Response slot, so a proxy, a copied prototype, an object tagged `Response`,
 * and a Response from another Fetch implementation all fail. The check reads no property of `value`.
 */
function isRuntimeResponse(value: unknown): value is Response {
  try {
    if (!nativeResponseStatus || value === null || typeof value !== "object" || !(value instanceof Response)) return false
    Reflect.apply(nativeResponseStatus, value, [])
    return true
  }
  catch (error) {
    // A native promise can throw here while constructing its species-derived
    // promise. An incompatible receiver (plain thenable/object) throws the
    // intrinsic TypeError instead.
    return !(error instanceof TypeError)
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

function getDirectRuntimeResponse(value: Response): Response | undefined {
  try {
    if (!nativeResponseStatus || !nativeResponseBodyUsed || !nativeResponseHeaders || !nativeResponseBody || !nativeResponseStatusText) return
    if (Reflect.apply(nativeResponseBodyUsed, value, [])) return
    const body = Reflect.apply(nativeResponseBody, value, [])
    const locked = body && Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")?.get
    if (locked && Reflect.apply(locked, body, [])) return
    const headers = Reflect.apply(nativeResponseHeaders, value, [])
    if (!headers || !nativeHeadersForEach || !nativeHeadersGet
      || Reflect.get(headers, "forEach") !== nativeHeadersForEach
      || Reflect.get(headers, "get") !== nativeHeadersGet) return
    const shadowed = ["status", "statusText", "headers", "body"].some((key) => {
      if (Object.prototype.hasOwnProperty.call(value, key)) return true
      let prototype: object | null = Object.getPrototypeOf(value)
      const seen = new Set<object>()
      while (prototype && prototype !== Response.prototype) {
        if (seen.has(prototype)) return true
        seen.add(prototype)
        if (Object.prototype.hasOwnProperty.call(prototype, key)) return true
        prototype = Object.getPrototypeOf(prototype)
      }
      return false
    })
    if (shadowed || Object.prototype.hasOwnProperty.call(value, "then")) {
      const clone = nativeResponseClone
      try { return clone ? Reflect.apply(clone, value, []) : undefined }
      catch { return }
    }
    Reflect.apply(nativeResponseStatus, value, [])
    Reflect.apply(nativeResponseStatusText, value, [])
    return value
  }
  catch {
    return
  }
}

/**
 * Only `true` grants access. A Response of this runtime is sent as the rejection. Every other value gets `403`.
 */
async function runAccessAuthorize(
  authorize: AuthAccessAuthorize,
  context: AuthAccessAuthorizationContext,
): Promise<{ response?: Response }> {
  const result: unknown = authorize(context)
  // Normalize response values before any thenable handling. A Response may
  // expose an own `then` property, but it must still be treated as a response
  // rather than assimilated as a promise.
  if (isRuntimeResponse(result)) {
    return { response: getDirectRuntimeResponse(result) ?? createForbiddenResponse(context.request) }
  }

  // Foreign-runtime Responses are not recognized by isRuntimeResponse. Try
  // the response snapshot before any await boundary so an own `then` method
  // cannot assimilate an otherwise valid response.
  if (result !== null && (typeof result === "object" || typeof result === "function")) {
    let thenDescriptor: PropertyDescriptor | undefined
    let thenShadowed = false
    try {
      thenDescriptor = Object.getOwnPropertyDescriptor(result, "then")
      if (thenDescriptor?.configurable) {
        Object.defineProperty(result, "then", { configurable: true, writable: true, value: undefined })
        thenShadowed = true
      }
      const normalized = await normalizeAuthorizationResponse(result)
      if (normalized) return { response: normalized }
    } catch {
      // Reflection or normalization failures must fail closed.
    } finally {
      if (thenShadowed && thenDescriptor) {
        try { Object.defineProperty(result, "then", thenDescriptor) } catch { /* ignore restoration failures */ }
      }
    }
  }

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
  if (isRuntimeResponse(resolved)) {
    const directResponse = getDirectRuntimeResponse(resolved)
    if (directResponse) return { response: directResponse }
  } else {
    const normalized = await normalizeAuthorizationResponse(resolved)
    if (normalized) return { response: normalized }
  }
  return { response: createForbiddenResponse(context.request) }
}

const authorizationResponseProperties = ["status", "statusText", "headers", "body"] as const

const authorizationResponsePrototypeLimit = 32

const nativeReaderMethods = Object.fromEntries(([
  "read", "cancel", "releaseLock",
] as const).map(key => [key, Object.getOwnPropertyDescriptor(ReadableStreamDefaultReader.prototype, key)?.value])) as Record<string, unknown>
const nativeStreamGetReader = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "getReader")?.value
function isNativeReaderMethod(value: unknown, key: string): value is (...args: unknown[]) => unknown {
  return value === nativeReaderMethods[key]
}

const foreignReaderMethods = new WeakMap<Function, Record<string, Function>>()

const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)?.get

function isUint8Array(value: unknown): value is Uint8Array {
  if (!typedArrayTagGetter) return false
  try {
    return Reflect.apply(typedArrayTagGetter, value, []) === "Uint8Array"
  }
  catch {
    return false
  }
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

let undiciResponsePromise: Promise<typeof Response | undefined> | undefined

async function getUndiciResponse(): Promise<typeof Response | undefined> {
  if (undiciResponsePromise) return undiciResponsePromise
  undiciResponsePromise = import(/* @vite-ignore */ "undici")
    .then(module => module.Response as typeof Response)
    .catch(() => undefined)
  return undiciResponsePromise
}

function isLocalResponseProxy(value: unknown): boolean {
  if (!(value instanceof Response)) return false
  try {
    const clone = Reflect.get(value, "clone")
    return clone === Object.getOwnPropertyDescriptor(Response.prototype, "clone")?.value
  }
  catch { return false }
}

async function hasResponsePrototype(value: unknown): Promise<boolean> {
  const targets = new Set<object>([Response.prototype])
  if (value instanceof Response) {
    try {
      const bodyUsed = Object.getOwnPropertyDescriptor(Response.prototype, "bodyUsed")?.get
      const status = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get
      const headers = Object.getOwnPropertyDescriptor(Response.prototype, "headers")?.get
      if (typeof bodyUsed !== "function" || typeof status !== "function" || typeof headers !== "function") return false
      Reflect.apply(bodyUsed, value, [])
      Reflect.apply(status, value, [])
      Reflect.apply(headers, value, [])
      return true
    }
    catch {
      // A proxy around a genuine local Response fails the intrinsic brand check,
      // but its clone still produces a branded response. Keep that supported
      // proxy path while rejecting ordinary Response.prototype lookalikes.
      try {
        const clone = Reflect.get(value, "clone")
        if (typeof clone === "function") {
          const nativeClone = Object.getOwnPropertyDescriptor(Response.prototype, "clone")?.value
          // Only the platform clone operation proves that a proxy targets a
          // genuine local Response; a caller-supplied clone can return any
          // branded response and must not establish provenance.
          if (clone === nativeClone) {
            try {
              const cloned = Reflect.apply(clone, value, [])
              if (cloned !== value && cloned instanceof Response) return true
            }
            catch { return false }
          }
        }
      }
      catch {}
      // Do not accept an exact Response.prototype as provenance after the
      // native brand check fails. Caller-created objects can inherit that
      // prototype and expose an arbitrary readable body and status.
    }
  }
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
    if (locked !== false) return false
    // Do not construct a Response here. The constructor acquires the source
    // stream's reader lock, and the bridge must acquire that same stream below.
    // The locked check above rejects streams that are already owned; native
    // reader validation and the bridge preserve lazy ownership for valid ones.
    return true
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
        if (!descriptor || typeof descriptor.value !== "function") return false
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


async function getNativeAuthorizationBodyReader(body: unknown): Promise<((this: object) => ReadableStreamDefaultReader<Uint8Array>) | undefined> {
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
        const tagDescriptor = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag)
        if (tagDescriptor?.value !== "ReadableStream") return
        // A reader on an intermediate prototype can shadow the stream
        // implementation. Genuine stream prototypes have no second reader
        // further up their chain, so reject shadowed methods before invoking.
        let parent = Object.getPrototypeOf(prototype)
        for (let parentDepth = 0; parent && parentDepth < authorizationResponsePrototypeLimit; parentDepth++) {
          if (Object.getOwnPropertyDescriptor(parent, "getReader")) return
          parent = Object.getPrototypeOf(parent)
        }
        // Probe and capture the source runtime's native reader methods. This
        // supports genuine streams from another realm while rejecting
        // caller-provided lookalikes through the native brand probes below.
        if (typeof descriptor.value === "function") {
          // Probe the source runtime's reader prototype before acquiring the
          // caller's body lock. This lets malformed foreign readers fail
          // closed without relying on a host-realm releaseLock operation.
          const probeStream = Reflect.construct(constructor, [{ start(controller: ReadableStreamDefaultController<Uint8Array>) { controller.close() } }]) as ReadableStream<Uint8Array>
          const probeReader = Reflect.apply(descriptor.value, probeStream, []) as object
          // A genuine getReader() must lock the stream it was called on.
          // This rejects branded-looking prototypes that return a reader for
          // an unrelated stream.
          if (!probeStream.locked || !hasNativeAuthorizationReaderPrototype(probeReader)) return
          const probePrototype = Object.getPrototypeOf(probeReader)
          const probeMethods = Object.fromEntries((["read", "cancel", "releaseLock"] as const).map(key => [
            key,
            Object.getOwnPropertyDescriptor(probePrototype, key)?.value,
          ])) as Record<string, Function>
          const readerMethodShape = { read: ["read", 0], cancel: ["cancel", 1], releaseLock: ["releaseLock", 0] } as const
          if ((Object.entries(probeMethods) as Array<[keyof typeof readerMethodShape, Function]>).some(([key, method]) =>
            typeof method !== "function"
            || method.name !== readerMethodShape[key][0]
            || method.length !== readerMethodShape[key][1]
            || Object.prototype.hasOwnProperty.call(method, "prototype"))) return
          // The local realm has immutable references captured above. A patched
          // local prototype must not become trusted merely because its
          // replacements return promise-shaped values during the probe.
          if (constructor === ReadableStream
            && (descriptor.value !== nativeStreamGetReader
              || (["read", "cancel", "releaseLock"] as const).some(key => probeMethods[key] !== nativeReaderMethods[key]))) return
          // Native reader operations enforce the reader brand before doing
          // any work. A replacement that merely returns a promise can mimic
          // the happy path on a probe reader, but it cannot pass this check
          // without reproducing the runtime's internal-slot guard.
          for (const key of ["read", "cancel", "releaseLock"] as const) {
            let invalidReceiverThrew = false
            try {
              const invalidReceiverResult = Reflect.apply(probeMethods[key], {}, key === "cancel" ? [undefined] : [])
              if (key === "releaseLock") {
                // Native releaseLock performs its brand check synchronously and
                // returns undefined for a valid reader.
                if (invalidReceiverResult !== undefined) return
                continue
              }
              if (invalidReceiverResult === null
                || (typeof invalidReceiverResult !== "object" && typeof invalidReceiverResult !== "function")
                || typeof (invalidReceiverResult as PromiseLike<unknown>).then !== "function") return
              // Native read/cancel reject asynchronously for an invalid
              // receiver. Observe that rejection so probing never leaks an
              // unhandled promise while retaining the brand check.
              void Promise.resolve(invalidReceiverResult).catch(() => undefined)
            }
            catch {
              // Expected: the operation rejects a non-reader receiver.
              invalidReceiverThrew = true
            }
            if (key === "releaseLock" && !invalidReceiverThrew) return
          }
          // Exercise every operation in the source runtime. This rejects
          // callable replacements that do not preserve Web Streams behavior,
          // without comparing implementation-specific function source text.
          const readResult = await Promise.resolve(Reflect.apply(probeMethods.read, probeReader, []))
          if (!readResult || typeof readResult !== "object" || readResult.done !== true || readResult.value !== undefined) return
          const cancelStream = Reflect.construct(constructor, [{}]) as ReadableStream<Uint8Array>
          const cancelReader = Reflect.apply(descriptor.value, cancelStream, []) as object
          const cancelResult = await Promise.resolve(Reflect.apply(probeMethods.cancel, cancelReader, []))
          if (cancelResult !== undefined) return
          Reflect.apply(probeMethods.releaseLock, cancelReader, [])
          if (cancelStream.locked) return
          const releaseStream = Reflect.construct(constructor, [{}]) as ReadableStream<Uint8Array>
          const releaseReader = Reflect.apply(descriptor.value, releaseStream, []) as object
          const releaseResult = Reflect.apply(probeMethods.releaseLock, releaseReader, [])
          if (releaseResult !== undefined || releaseStream.locked) return

          // Prove that the selected getReader method returns a reader for the
          // exact stream it was called on. A forged method can lock the body
          // and return a reader owned by another stream; releasing that reader
          // leaves the supplied body locked, which provides an observable
          // ownership check before the bridge accepts the method.
          const ownershipReader = Reflect.apply(descriptor.value, body, []) as object
          if (!(body as ReadableStream).locked) return
          Reflect.apply(probeMethods.releaseLock, ownershipReader, [])
          if ((body as ReadableStream).locked) return
          const readerConstructor = Object.getOwnPropertyDescriptor(probePrototype, "constructor")?.value
          if (typeof readerConstructor === "function") foreignReaderMethods.set(readerConstructor, probeMethods)
          foreignReaderMethods.set(constructor, probeMethods)
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

function hasMergedCookieBoundary(value: string): boolean {
  let segmentStart = 0
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (character === ";") {
      segmentStart = index + 1
      continue
    }
    if (character !== ",") continue
    const segment = value.slice(segmentStart).trim()
    // Extension attributes are explicitly allowed to contain commas, even
    // when the following text resembles another cookie assignment.
    if (/^Extension\s*=/i.test(segment)) continue
    if (/^\s*[^;=,\s]+\s*=/.test(value.slice(index + 1))) return true
  }
  return false
}

function bridgeAuthorizationBody(body: ReadableStream<Uint8Array>, getReader: (this: object) => ReadableStreamDefaultReader<Uint8Array>) {
  // Invoke the source stream's native operations so separate realms retain their brand.
  const reader = Reflect.apply(getReader, body, [])
  // Ensure the returned reader owns the supplied body; an override that
  // returns a reader for another stream must never cross the boundary.
  if (!body.locked) throw new Error("Authorization response reader does not own body")
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
        const expected = foreignReaderMethods.get(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(reader), "constructor")?.value as Function)?.[key]
        if ((expected ? descriptor.value !== expected : !isNativeReaderMethod(descriptor.value, key))
          || constructor?.name !== "ReadableStreamDefaultReader") {
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
        const readerConstructor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(reader), "constructor")?.value as Function
        const expected = foreignReaderMethods.get(readerConstructor)?.releaseLock
        // Keep the verified source-runtime intrinsic even when the reader's
        // visible method was replaced. Validation will reject that reader,
        // but the intrinsic can still release its brand-held lock.
        if (typeof expected === "function") sourceReleaseLock = expected as (this: object) => unknown
        else if (typeof descriptor.value === "function" && isNativeReaderMethod(descriptor.value, "releaseLock")) {
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
  const acquire = async () => reader
  const release = () => {
    if (released) return
    released = true
    Reflect.apply(releaseLock, reader, [])
  }
  try {
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await Reflect.apply(read, reader, []) as { done: boolean; value?: Uint8Array }
          if (typeof result?.done !== "boolean") throw new Error("Malformed authorization response reader result")
          if (result.done) {
            release()
            controller.close()
          } else if (!isUint8Array(result.value)) {
            throw new Error("Malformed authorization response reader chunk")
          } else controller.enqueue(result.value)
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
  catch (error) {
    release()
    throw error
  }
}

async function normalizeAuthorizationResponse(value: unknown): Promise<Response | undefined> {
  if (value === null || Object(value) !== value) return
  // Native responses are validated below with their intrinsic accessors.
  try {
    const candidate = Object(value)
    if (!await hasResponsePrototype(candidate)) return
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
    if (body !== null) {
      const bodyUsedGetter = responsePropertyDescriptor(candidate, "bodyUsed")?.get
      try {
        if (typeof bodyUsedGetter !== "function") return
        const used = isLocalResponseProxy(candidate) ? Reflect.get(candidate, "bodyUsed") : Reflect.apply(bodyUsedGetter, candidate, [])
        if (used) return
      }
      catch {
        return
      }
    }

    const headerCarrier = Object(headers)
    const snapshot = { status, statusText, headers, body }
    if (value instanceof Response && status === 0 && statusText === "" && body === null
      && headers instanceof Headers
      && authorizationResponseProperties.every(key =>
        responsePropertyDescriptor(candidate, key)?.get === Object.getOwnPropertyDescriptor(Response.prototype, key)?.get)
      && !authorizationResponseProperties.some(key => Object.prototype.hasOwnProperty.call(candidate, key))) return value
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
    const UndiciResponse = await getUndiciResponse()
    let foreignHeadersPrototype: object | undefined
    try {
      if (UndiciResponse) foreignHeadersPrototype = Object.getPrototypeOf(new UndiciResponse().headers)
    }
    catch {
      foreignHeadersPrototype = undefined
    }
    const currentHeadersPrototype = Headers.prototype
    const currentForEach = Object.getOwnPropertyDescriptor(currentHeadersPrototype, "forEach")?.value
    const foreignForEach = foreignHeadersPrototype && Object.getOwnPropertyDescriptor(foreignHeadersPrototype, "forEach")?.value
    const headerForEach = responsePropertyDescriptor(headerCarrier, "forEach")?.value
    const trustedForEach = headerForEach === currentForEach ? currentForEach
      : headerForEach === foreignForEach ? foreignForEach
      : undefined
    const nativeHeaderMethods = ["get", "forEach"].every(key => {
      const method = responsePropertyDescriptor(headerCarrier, key)?.value
      return method === Object.getOwnPropertyDescriptor(currentHeadersPrototype, key)?.value
        || (foreignHeadersPrototype !== undefined && method === Object.getOwnPropertyDescriptor(foreignHeadersPrototype, key)?.value)
    }) && typeof trustedForEach === "function"
    // A foreign implementation must carry its own native Headers methods.
    // Accepting a foreign Response prototype paired with current-realm Headers
    // would make a user-defined Response-shaped object indistinguishable from
    // a genuine cross-runtime response.
    const cookieDescriptor = responsePropertyDescriptor(headerCarrier, "getSetCookie")
    const nativeCookieMethod = !cookieDescriptor?.get && (cookieDescriptor?.value === undefined
      || cookieDescriptor.value === Object.getOwnPropertyDescriptor(Headers.prototype, "getSetCookie")?.value
      || (foreignHeadersPrototype !== undefined && cookieDescriptor.value === Object.getOwnPropertyDescriptor(foreignHeadersPrototype, "getSetCookie")?.value))

    let nativeBodyReader = body === null
      ? (() => { throw new Error("A null body has no reader") })
      : await getNativeAuthorizationBodyReader(body)
    // Body validation above yields while resolving foreign stream intrinsics.
    // Recheck the trusted body-used state immediately before bridging so a
    // concurrent consumer cannot turn an already-disturbed response into an
    // accepted authorization result.
    if (body !== null) {
      try {
        const bodyUsedGetter = responsePropertyDescriptor(candidate, "bodyUsed")?.get
        if (typeof bodyUsedGetter !== "function") return
        const used = isLocalResponseProxy(candidate)
          ? Reflect.get(candidate, "bodyUsed")
          : Reflect.apply(bodyUsedGetter, candidate, [])
        if (used) return
      }
      catch {
        return
      }
    }
    if (value instanceof Response && nativeProperties && nativeBodyUnused && nativeHeaderMethods && nativeCookieMethod && nativeBodyReader) return value
    // A genuine stream from an arbitrary realm cannot safely donate its
    // reader methods across the boundary. The platform Response constructor
    // performs the source-runtime brand check and creates a host stream whose
    // captured intrinsics can be bridged without executing foreign methods.
    // A non-null body must be a validated native ReadableStream. Passing an
    // arbitrary value to Response would stringify it into a new stream and
    // incorrectly admit the malformed authorization result.
    if (!nativeBodyReader || !isSerializableAuthorizationBody(body, nativeBodyReader)) return

    const forEach = trustedForEach
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
    // Preserve one cookie when the fallback exposes only a combined value. A comma
    // followed by another cookie assignment at the cookie-pair boundary proves that
    // multiple values were merged. Also reject assignment-like text after a standard
    // cookie attribute (for example `Path=/, next=2`), which is another merged-cookie
    // boundary. Arbitrary extension attributes may legitimately contain commas.
    if (combinedCookies !== undefined) {
      if (hasMergedCookieBoundary(combinedCookies)) return
      normalizedHeaders.append("set-cookie", combinedCookies)
    }
    for (const cookie of cookies) normalizedHeaders.append("set-cookie", cookie)


    // Validate status and native body state before acquiring reader ownership.
    // Do not construct a Response around a non-null stream here: the Response
    // constructor acquires the stream's reader, which would prevent the bridge
    // below from acquiring it again.
    if (body === null) {
      return status === 0 && statusText === "" && [...normalizedHeaders].length === 0
        ? Response.error()
        : new Response(null, { status, statusText, headers: normalizedHeaders })
    }
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
