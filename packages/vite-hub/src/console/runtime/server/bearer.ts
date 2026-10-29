import { resolvePublicUrl } from "@vite-hub/runtime"
import { createLocalJWKSet, jwtVerify } from "jose"

import type { JSONWebKeySet } from "jose"
import type { ConsoleUser } from "../../auth.ts"
import type { ConsoleDiagnosticCode } from "../diagnostics.ts"
import type { ConsoleRequestEvent } from "./request.ts"

/** The scope that lets a token call `read` operations. */
export const consoleMcpReadScope = "vitehub:read"
/** The scope that lets a token call `write` and `destructive` operations. */
export const consoleMcpWriteScope = "vitehub:write"
export const consoleMcpScopes: readonly string[] = [consoleMcpReadScope, consoleMcpWriteScope]

/** What the Console reads from the Better Auth context of the app. */
interface ConsoleOAuthContext {
  baseURL: string
  getPlugin?: (id: string) => { options?: unknown } | null | undefined
  internalAdapter: { findUserById: (id: string) => Promise<unknown> }
  options?: { plugins?: ReadonlyArray<{ id?: string, options?: unknown }> }
}

/** The Better Auth instance of the app, as far as the Console uses it. It reads keys and users in-process, never over HTTP. */
export interface ConsoleOAuthAuth {
  $context: Promise<ConsoleOAuthContext>
  api: {
    getJwks: () => Promise<unknown>
    getOAuthServerConfig?: (input: { asResponse: false, headers: Headers }) => Promise<unknown>
  }
}

/** How the Console signs MCP clients in. Generated output installs it with the access policy. */
export interface ConsoleOAuthConfig {
  /** The Better Auth instance of the Auth that signs people in, built for the given request. */
  auth: (request: Request, event: ConsoleRequestEvent) => ConsoleOAuthAuth
  /** Console Auth authorization for a verified token identity, without a browser session. */
  authorize?: (context: { request: Request, user: ConsoleUser }) => boolean | Response | Promise<boolean | Response>
  /** Issuer of the access tokens. Absolute. Without it, the issuer of the Auth: its `jwt.issuer`, else its `baseURL`. */
  issuer?: string
  /** Mounted path of the endpoint, with the app base: `/_vitehub/mcp`, or `/portal/_vitehub/mcp`. */
  path: string
  /** Resource identifier of the endpoint, `<origin>/_vitehub/mcp`. Absolute. Without it, the origin below plus `path`. */
  resource?: string
}

export type ConsoleOAuthState =
  | { ready: true, auth: ConsoleOAuthAuth, context: ConsoleOAuthContext, issuer: string, metadataUrl: string, resource: string }
  | { ready: false, code: ConsoleDiagnosticCode, message: string }

const wellKnownPrefix = "/.well-known/oauth-protected-resource"
const probeOrigin = "https://mcp-probe.invalid"
const clockToleranceSeconds = 30
const states = new WeakMap<object, Promise<ConsoleOAuthState>>()
const rejections = new WeakSet<Response>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

/** The bearer token of a request, or undefined. */
export function bearerToken(request: Request): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
}

/**
 * Whether the request is for the MCP endpoint: its path is exactly the mounted one. An access token opens nothing else,
 * so a path that only contains it, such as `/_vitehub/rpc/_vitehub/mcp`, is not the endpoint.
 */
export function isMcpPath(config: Pick<ConsoleOAuthConfig, "path">, request: Pick<Request, "url">): boolean {
  return new URL(request.url).pathname === config.path
}

function findPlugin(context: ConsoleOAuthContext, id: string): { options?: unknown } | undefined {
  const found = context.getPlugin?.(id) ?? context.options?.plugins?.find(plugin => plugin.id === id)
  return found ?? undefined
}

function pluginOptions(plugin: { options?: unknown } | undefined): Record<string, unknown> {
  return isRecord(plugin?.options) ? plugin.options : {}
}

function jwtIssuer(context: ConsoleOAuthContext): string {
  const jwt = pluginOptions(findPlugin(context, "jwt")).jwt
  return isRecord(jwt) && typeof jwt.issuer === "string" && jwt.issuer ? jwt.issuer : context.baseURL
}

/** What the Auth must have so that Better Auth issues access tokens that the Console can check. Empty when it is complete. */
function missingOAuthSetup(context: ConsoleOAuthContext, resource: string): string[] {
  const missing: string[] = []
  if (!findPlugin(context, "jwt")) missing.push("the `jwt()` plugin")
  const issuer = jwtIssuer(context)
  // Better Auth 1.7.7 normalizes discovery but copies this option verbatim into access-token claims.
  if (issuer !== new URL(issuer).toString().replace(/\/$/, "")) {
    missing.push(`a canonical \`jwt.issuer\` without a trailing slash, such as ${JSON.stringify(new URL(issuer).toString().replace(/\/+$/, ""))}, so discovery and access tokens have the same issuer`)
  }
  const provider = findPlugin(context, "oauth-provider")
  if (!provider) {
    missing.push("the `oauthProvider()` plugin")
    return missing
  }
  const options = pluginOptions(provider)
  const resources = Array.isArray(options.resources) ? options.resources.map(entry => isRecord(entry) ? entry.identifier : entry) : []
  if (!resources.includes(resource)) missing.push(`\`resources: [${JSON.stringify(resource)}]\` in \`oauthProvider()\`, without which Better Auth issues opaque tokens`)
  const defaults = Array.isArray(options.clientRegistrationDefaultResources) ? options.clientRegistrationDefaultResources : []
  if (!defaults.includes(resource)) missing.push(`\`clientRegistrationDefaultResources: [${JSON.stringify(resource)}]\` in \`oauthProvider()\`, so dynamically registered MCP clients can request this resource`)
  const scopes = Array.isArray(options.scopes) ? options.scopes : []
  const absent = consoleMcpScopes.filter(scope => !scopes.includes(scope))
  if (absent.length) missing.push(`the scopes ${absent.map(scope => JSON.stringify(scope)).join(" and ")} in \`oauthProvider({ scopes })\``)
  if (options.disableJwtPlugin === true) missing.push("`disableJwtPlugin` off in `oauthProvider()`")
  return missing
}

async function trustedOrigin(config: ConsoleOAuthConfig, event: ConsoleRequestEvent, request: Request, development: boolean): Promise<string | undefined> {
  if (config.resource) return new URL(config.resource).origin
  const configured = resolvePublicUrl()
  if (configured) return new URL(configured).origin
  // An Auth that sets its own `baseURL` answers the same for any request. One that follows the request would answer the probe's origin.
  const declared = new URL((await config.auth(new Request(`${probeOrigin}/`), event).$context).baseURL || probeOrigin)
  if (declared.origin !== probeOrigin) return declared.origin
  // The development server has no fixed origin, and its keys are read in-process, so a forged Host gains nothing.
  return development ? new URL(request.url).origin : undefined
}

async function buildState(config: ConsoleOAuthConfig, event: ConsoleRequestEvent, request: Request, development: boolean): Promise<ConsoleOAuthState> {
  try {
    const origin = await trustedOrigin(config, event, request, development)
    if (!origin) {
      return {
        code: "CONSOLE_MCP_ORIGIN_REQUIRED",
        message: "OAuth sign-in for MCP is off: the server has no configured public origin, and the Console does not trust the Host header of a request to name the token issuer.",
        ready: false,
      }
    }
    const resource = config.resource ?? `${origin}${config.path}`
    // The Auth is built for the trusted origin, so a baseURL that follows the request still gets the configured origin.
    const auth = config.auth(new Request(`${origin}${config.path}`), event)
    const context = await auth.$context
    const missing = missingOAuthSetup(context, resource)
    if (missing.length) {
      return {
        code: "CONSOLE_MCP_OAUTH_INCOMPLETE",
        message: `The Auth that signs the Console in cannot issue MCP access tokens. It needs ${missing.join(", ")}.`,
        ready: false,
      }
    }
    return {
      auth,
      context,
      issuer: config.issuer ?? jwtIssuer(context),
      metadataUrl: `${origin}${wellKnownPrefix}${new URL(resource).pathname}`,
      ready: true,
      resource,
    }
  }
  catch (error) {
    return {
      code: "CONSOLE_AUTH_NOT_CONFIGURED",
      message: `The Auth that signs the Console in could not start: ${error instanceof Error ? error.message : "unknown error"}`,
      ready: false,
    }
  }
}

/**
 * The trusted OAuth settings of this request: the Auth of the app, the token issuer, and the resource identifier. They come
 * from configuration only (`console.mcp`, `vitehub({ publicUrl })`, the `baseURL` that the Auth declares), never from the
 * Host of the request, except in `vite dev`. Without any, OAuth is off and the state says why.
 */
export function resolveConsoleOAuth(config: ConsoleOAuthConfig, event: ConsoleRequestEvent, request: Request, development: boolean): Promise<ConsoleOAuthState> {
  const cached = states.get(event)
  if (cached) return cached
  const state = buildState(config, event, request, development)
  if (isRecord(event)) states.set(event, state)
  return state
}

/** The `WWW-Authenticate` value of a `401` or `403` of the endpoint. */
export function mcpChallenge(state: ConsoleOAuthState | undefined, parameters: { description?: string, error?: "insufficient_scope" | "invalid_token", scope?: string } = {}): string {
  const fields = [
    ...(parameters.error ? [`error="${parameters.error}"`] : []),
    ...(parameters.description ? [`error_description="${parameters.description.replaceAll("\"", "'")}"`] : []),
    ...(parameters.scope ? [`scope="${parameters.scope}"`] : []),
    ...(state?.ready ? [`resource_metadata="${state.metadataUrl}"`] : []),
  ]
  return fields.length ? `Bearer ${fields.join(", ")}` : "Bearer realm=\"vitehub-console\""
}

/** Mark a bearer rejection, so the MCP endpoint keeps its challenge instead of building the sign-in one. */
export function markBearerRejection(response: Response): Response {
  rejections.add(response)
  return response
}

export function isBearerRejection(response: Response): boolean {
  return rejections.has(response)
}

export type ConsoleBearerResult =
  | { ok: true, scopes: readonly string[], user: ConsoleUser }
  | { ok: false, state: ConsoleOAuthState }

function grantedScopes(payload: Record<string, unknown>): string[] {
  const scope = payload.scope
  if (typeof scope === "string") return scope.split(/\s+/).filter(Boolean)
  return Array.isArray(scope) ? scope.filter((entry): entry is string => typeof entry === "string") : []
}

function jwksOf(value: unknown): JSONWebKeySet | undefined {
  return isRecord(value) && Array.isArray(value.keys) ? value as unknown as JSONWebKeySet : undefined
}

function bannedUser(user: Record<string, unknown>): boolean {
  if (user.banned !== true) return false
  const until = user.banExpires instanceof Date ? user.banExpires.getTime() : typeof user.banExpires === "string" || typeof user.banExpires === "number" ? new Date(user.banExpires).getTime() : undefined
  return until === undefined || Number.isNaN(until) || until > Date.now()
}

/**
 * Check an OAuth access token that Better Auth's `oauthProvider` and `jwt` plugins issued for the MCP endpoint. The keys
 * come from the app's own Auth in-process, and the issuer and audience from trusted configuration: a request cannot pick
 * them. The signature algorithm is pinned to the ones in the key set. The person is read from the Auth by the `sub` claim,
 * so a deleted or banned user loses access with the token still unexpired.
 *
 * Returns undefined when the request carries no token for this endpoint, `ok: false` for a token that is not valid. It never throws.
 */
export async function verifyConsoleBearer(request: Request, event: ConsoleRequestEvent, config: ConsoleOAuthConfig, development: boolean): Promise<ConsoleBearerResult | undefined> {
  const token = bearerToken(request)
  // An access token is for the MCP endpoint only. Other Console routes keep to the session.
  if (!token || !isMcpPath(config, request)) return undefined
  const state = await resolveConsoleOAuth(config, event, request, development)
  if (!state.ready) return { ok: false, state }
  try {
    const jwks = jwksOf(await state.auth.api.getJwks())
    const algorithms = [...new Set((jwks?.keys ?? []).flatMap(key => typeof key.alg === "string" ? [key.alg] : []))]
    if (!jwks || !algorithms.length) return { ok: false, state }
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      algorithms,
      audience: state.resource,
      clockTolerance: clockToleranceSeconds,
      issuer: state.issuer,
      requiredClaims: ["exp", "sub"],
    })
    const user = await state.context.internalAdapter.findUserById(payload.sub!)
    if (!isRecord(user) || bannedUser(user)) return { ok: false, state }
    // SAFETY: A Console user is an Auth user record, which is what the adapter returns.
    return { ok: true, scopes: grantedScopes(payload), user: user as ConsoleUser }
  }
  catch {
    return { ok: false, state }
  }
}
