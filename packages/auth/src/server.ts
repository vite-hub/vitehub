import discoveredDefinition from "#vitehub/auth/definition"
import { betterAuth } from "better-auth"

import { normalizeAuthBasePath } from "./shared.ts"
import { throwAuthenticationProviderError } from "./errors.ts"
import { getAuthenticationSession } from "./session.ts"

import type {
  AuthAccessConfiguration,
  AuthAccessAuthorizationContext,
  AuthAccessRoute,
  AuthBetterAuthRuntimeOptions,
  AuthDefinition,
  AuthDefinitionResolver,
  AuthRequest,
  AuthRequestInput,
  AuthRuntimeContext,
  AuthRuntimeOptions,
  AuthRuntimeOptionsResolver,
  AuthSignInConfiguration,
  ViteHubAuth,
} from "./types.ts"

type AuthRuntimeEnvResolver = (event?: unknown) => Record<string, unknown>

function hasRuntimeOptions(options: AuthRuntimeOptions | undefined): boolean {
  return Boolean(options && Object.keys(options).length > 0)
}

function hasRequestRuntimeOptions(definition: AuthDefinition): boolean {
  if (typeof definition.options === "function") return true
  return typeof definition.options.runtime === "function"
}

let authRuntimeEnvResolver: AuthRuntimeEnvResolver | undefined

export function setAuthRuntimeEnvResolver(resolver: AuthRuntimeEnvResolver | undefined): void {
  authRuntimeEnvResolver = resolver
}

function resolveAuthRuntimeEnv(event?: unknown): Record<string, unknown> {
  return authRuntimeEnvResolver?.(event) ?? {}
}

function requestOrigin(request?: Pick<Request, "url">): string {
  return request ? new URL(request.url).origin : "http://localhost"
}

function createAuthRuntimeContext(
  request?: Pick<Request, "headers" | "url">,
  event?: unknown,
): AuthRuntimeContext {
  return {
    env: resolveAuthRuntimeEnv(event ?? request),
    ...(request ? { request } : {}),
    requestOrigin: requestOrigin(request),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isAuthDatabaseMetadata(value: unknown): boolean {
  return value === true
    || (
      isPlainObject(value)
      && typeof value.name === "string"
      && Object.keys(value).every(key => key === "dedicated" || key === "name")
    )
}

function isAuthSecondaryStorageMetadata(value: unknown): boolean {
  return value === true
    || (
      isPlainObject(value)
      && typeof value.store === "string"
      && Object.keys(value).every(key => key === "store")
    )
}

function resolveDefinitionOptions(
  definition: AuthDefinition,
  request?: Pick<Request, "headers" | "url">,
  event?: unknown,
  runtimeOptions: AuthRuntimeOptions = {},
): AuthRuntimeOptions & Record<string, unknown> {
  const context = createAuthRuntimeContext(request, event)
  const options = (typeof definition.options === "function"
    ? (definition.options as AuthDefinitionResolver)(context)
    : definition.options) as AuthRuntimeOptions & Record<string, unknown>
  const runtime = options.runtime
  const resolvedRuntime = !runtime
    ? {}
    : typeof runtime === "function"
      ? (runtime as AuthRuntimeOptionsResolver)(context)
      : runtime
  return {
    ...options,
    ...resolvedRuntime,
    ...runtimeOptions,
  }
}

function resolveRequestRuntimeOptions(
  definition: AuthDefinition,
  request: Pick<Request, "headers" | "url">,
  event?: unknown,
): AuthRuntimeOptions & Record<string, unknown> {
  if (typeof definition.options === "function") {
    return resolveDefinitionOptions(definition, request, event)
  }

  const runtime = definition.options.runtime
  if (!runtime) return {}
  const context = createAuthRuntimeContext(request, event)
  return (typeof runtime === "function"
    ? (runtime as AuthRuntimeOptionsResolver)(context)
    : runtime) as AuthRuntimeOptions & Record<string, unknown>
}

function hasStaticTrustedOrigins(definition: AuthDefinition): boolean {
  return typeof definition.options !== "function" && "trustedOrigins" in definition.options
}

function definitionBasePath(definition: AuthDefinition): string | undefined {
  if (typeof definition.options === "function") return
  return definition.options.basePath
}

function stripViteHubOptions(
  options: AuthRuntimeOptions & Record<string, unknown>,
): AuthBetterAuthRuntimeOptions {
  const {
    access: _access,
    database,
    route: _route,
    runtime: _runtime,
    secondaryStorage,
    ...rest
  } = options

  return {
    ...rest,
    ...(!isAuthDatabaseMetadata(database) ? { database } : {}),
    ...(!isAuthSecondaryStorageMetadata(secondaryStorage) ? { secondaryStorage } : {}),
    basePath: normalizeAuthBasePath(typeof options.basePath === "string" ? options.basePath : undefined),
  } as AuthBetterAuthRuntimeOptions
}

interface RequestInitWithDuplex extends RequestInit {
  duplex?: "half"
}

function hasTrustedOrigins(options: object): boolean {
  return "trustedOrigins" in options
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

function unwrapAuthRequest(input: AuthRequestInput): AuthRequest {
  return "req" in input ? input.req : input
}

export function createAuthRequestRuntimeOptions(
  definition: AuthDefinition,
  request: Pick<Request, "headers" | "url">,
  runtimeOptions: AuthRuntimeOptions = {},
  event?: unknown,
): AuthRuntimeOptions {
  const requestRuntimeOptions = {
    ...resolveRequestRuntimeOptions(definition, request, event),
    ...runtimeOptions,
  }
  const baseURL = requestRuntimeOptions.baseURL || new URL(request.url).origin
  return {
    baseURL,
    ...(!hasTrustedOrigins(requestRuntimeOptions) && !hasStaticTrustedOrigins(definition) ? { trustedOrigins: [baseURL] } : {}),
    ...requestRuntimeOptions,
  } as AuthRuntimeOptions
}

const authRuntimeStateKey = Symbol.for("vitehub.auth.runtime")

interface AuthRuntimeState {
  auth?: ViteHubAuth
  definition?: AuthDefinition
}

function getAuthRuntimeState(): AuthRuntimeState {
  const globalScope = globalThis as typeof globalThis & {
    [authRuntimeStateKey]?: AuthRuntimeState
  }
  globalScope[authRuntimeStateKey] ??= {}
  return globalScope[authRuntimeStateKey]
}

function resolveDefaultDefinition(): AuthDefinition {
  if (!discoveredDefinition) {
    throw new Error("[vitehub] No Auth Definition was discovered. Add `server/auth.ts` or `server.auth.ts`.")
  }
  return discoveredDefinition
}

export function createBetterAuthOptions(
  definition: AuthDefinition,
  runtimeOptions: AuthRuntimeOptions = {},
): AuthBetterAuthRuntimeOptions {
  return stripViteHubOptions(resolveDefinitionOptions(definition, undefined, undefined, runtimeOptions))
}

function createBetterAuthOptionsFromResolved(
  options: AuthRuntimeOptions & Record<string, unknown>,
): AuthBetterAuthRuntimeOptions {
  return stripViteHubOptions(options)
}

function createAuthenticationProvider(options: AuthBetterAuthRuntimeOptions): ViteHubAuth {
  try {
    return betterAuth(options) as ViteHubAuth
  }
  catch (cause) {
    throwAuthenticationProviderError(cause, "get-auth-for-request")
  }
}

function resolveBetterAuthOptionsForRequest(
  definition: AuthDefinition,
  request: Pick<Request, "headers" | "url">,
  runtimeOptions?: AuthRuntimeOptions,
  event?: unknown,
): AuthBetterAuthRuntimeOptions {
  const requestRuntimeOptions = createAuthRequestRuntimeOptions(definition, request, runtimeOptions, event) as AuthRuntimeOptions & Record<string, unknown>
  return createBetterAuthOptionsFromResolved(resolveDefinitionOptions(definition, request, event, requestRuntimeOptions))
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
  return betterAuth(resolveBetterAuthOptionsForRequest(definition, request, runtimeOptions, event)) as ViteHubAuth
}

export function handleAuthRequest(
  definition: AuthDefinition,
  request: AuthRequest,
  runtimeOptions?: AuthRuntimeOptions,
  event?: unknown,
): Promise<Response> {
  return createAuthForRequest(definition, request, runtimeOptions, event).handler(toRequest(request))
}

export function createAuthHandler(
  definition: AuthDefinition,
  runtimeOptions?: AuthRuntimeOptions,
): ViteHubAuth["handler"] {
  return createAuth(definition, runtimeOptions).handler
}

export function resetAuth(): void {
  const state = getAuthRuntimeState()
  state.auth = undefined
  state.definition = undefined
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
  if (!hasRequestRuntimeOptions(definition) && !hasRuntimeOptions(runtimeOptions)) {
    return getAuthForDefinition(definition)
  }
  return createAuthenticationProvider(resolveBetterAuthOptionsForRequest(definition, request, runtimeOptions, event))
}

export async function assertAuthOrigin(
  request: Pick<Request, "headers" | "url">,
  event?: unknown,
): Promise<ViteHubAuth> {
  const origin = request.headers.get("origin")
  if (!origin) throw new TypeError("The request origin is required.")
  const auth = getAuthForRequest(request, undefined, event)
  if (!(await auth.$context).isTrustedOrigin(origin)) {
    throw new TypeError("The request origin is not trusted.")
  }
  return auth
}

export function handleAuth(
  input: AuthRequestInput,
  runtimeOptions?: AuthRuntimeOptions,
): Promise<Response> {
  const request = unwrapAuthRequest(input)
  return handleAuthRequest(resolveDefaultDefinition(), request, runtimeOptions, input)
}

function authRequestBasePath(definition: AuthDefinition, request: Pick<Request, "headers" | "url">, event?: unknown): string {
  const options = createAuthRequestRuntimeOptions(definition, request, {}, event) as AuthRuntimeOptions & { basePath?: unknown }
  return normalizeAuthBasePath(typeof options.basePath === "string" ? options.basePath : definitionBasePath(definition))
}

function authBaseURL(definition: AuthDefinition, request: Pick<Request, "headers" | "url">, event?: unknown): string {
  return new URL(createAuthRequestRuntimeOptions(definition, request, {}, event).baseURL as string).origin
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

function authAccessRoute(
  definition: AuthDefinition,
  request: Pick<Request, "headers" | "url">,
  event: unknown,
  routeIndex: number,
): AuthAccessRoute {
  const routes = (resolveDefinitionOptions(definition, request, event) as { access?: AuthAccessConfiguration }).access?.routes
  const route = routes?.[routeIndex]
  if (!route) {
    throw new TypeError(`[vitehub] Auth access route ${routeIndex} is unavailable at runtime.`)
  }
  return route
}

async function createSignInResponse(
  definition: AuthDefinition,
  request: AuthRequest,
  signIn: AuthSignInConfiguration,
  event?: unknown,
): Promise<Response> {
  const origin = authBaseURL(definition, request, event)
  const response = await handleAuthRequest(definition, new Request(`${origin}${authRequestBasePath(definition, request, event)}/sign-in/social`, {
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
  }), undefined, event)

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

async function requireAuthRequest(
  input: AuthRequestInput,
  definition: AuthDefinition,
  routeIndex?: number,
): Promise<Response | undefined> {
  const request = unwrapAuthRequest(input)
  const auth = createAuthenticationProvider(resolveBetterAuthOptionsForRequest(definition, request, undefined, input))
  const session = await getAuthenticationSession(auth, { headers: request.headers })
  if (session) {
    if (routeIndex === undefined) return
    const route = authAccessRoute(definition, request, input, routeIndex)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- AuthAccessRoute is a validated string-or-object union, and this selects its declared member.
    const authorize = typeof route === "string" ? undefined : route.authorize
    if (!authorize) return

    const context: AuthAccessAuthorizationContext = {
      request,
      session: session.session,
      user: session.user,
    }
    const result = await authorize(context)
    if (result === true) return
    if (result instanceof Response) return result
    return createForbiddenResponse(request)
  }

  if (!wantsHtml(request)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 })
  }

  if (new URL(request.url).searchParams.has("auth_error")) {
    return new Response("Unauthorized.", {
      headers: { "content-type": "text/plain; charset=utf-8" },
      status: 403,
    })
  }

  const signIn = (resolveDefinitionOptions(definition, request, input) as { access?: AuthAccessConfiguration }).access?.signIn
  return signIn
    ? await createSignInResponse(definition, request, signIn, input)
    : Response.json({ error: "Unauthorized." }, { status: 401 })
}

export async function requireAuth(
  input: AuthRequestInput,
  definition: AuthDefinition = resolveDefaultDefinition(),
): Promise<Response | undefined> {
  return requireAuthRequest(input, definition)
}

export async function requireAuthAccessRoute(
  input: AuthRequestInput,
  routeIndex: number,
  definition: AuthDefinition = resolveDefaultDefinition(),
): Promise<Response | undefined> {
  if (!Number.isSafeInteger(routeIndex) || routeIndex < 0) {
    throw new TypeError("[vitehub] Auth access route index must be a non-negative integer.")
  }
  return requireAuthRequest(input, definition, routeIndex)
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
