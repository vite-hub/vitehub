import { isRuntimeResponse } from "@vite-hub/runtime/internal/runtime-type"

import { consoleDiagnosticBody, consoleStatusDiagnosticCode, isConsoleDiagnosticCode } from "../diagnostics.ts"

import type { ConsoleAccess } from "./access.ts"
import type { ConsoleRequestEvent } from "./request.ts"

/**
 * Browser origins that may call Console data routes from another origin, from `console.origins`. Generated Console
 * output installs them with `auth: "token"` and with an Auth that issues OAuth access tokens, the modes that verify a
 * bearer token on these routes. The OAuth client allow list of `consoleMcpOAuth()` reads the same list. Without an
 * installed list, every cross-origin call is rejected.
 */
const originsKey: unique symbol = Symbol.for("vitehub.console.origins")
// SAFETY: This module owns the process slot shared by separately bundled generated plugins and Console routes.
const scope = globalThis as typeof globalThis & { [originsKey]?: readonly string[] }

/** The Console data routes that answer a cross-origin call and accept a bearer token, below any application mount. */
export const consoleDataRoutes: readonly string[] = ["/_vitehub/rpc/__call", "/_vitehub/rpc/__upload", "/_vitehub/auth/manage", "/_vitehub/env/manage", "/_vitehub/channels/replay"]

/** The request headers that a listed origin may send. The CLI surface and project headers stay same-origin. */
export const consoleCorsAllowedHeaders = "authorization, content-type, x-vitehub-console"

export function installConsoleOrigins(origins: readonly string[]): void {
  scope[originsKey] = Object.freeze([...origins])
}

export function installedConsoleOrigins(): readonly string[] {
  return scope[originsKey] ?? []
}

/**
 * The `WWW-Authenticate` value of a Console data route that needs a bearer token: `Bearer realm="vitehub-console"`, an
 * optional error, and `resource_metadata` when the app issues OAuth access tokens for the Console resource (RFC 9728).
 */
export function consoleBearerChallenge(parameters: { description?: string, error?: "insufficient_scope" | "invalid_token", resourceMetadata?: string, scope?: string } = {}): string {
  return [
    `Bearer realm="vitehub-console"`,
    ...(parameters.error ? [`error="${parameters.error}"`] : []),
    ...(parameters.description ? [`error_description="${parameters.description.replaceAll("\"", "'")}"`] : []),
    ...(parameters.scope ? [`scope="${parameters.scope}"`] : []),
    ...(parameters.resourceMetadata ? [`resource_metadata="${parameters.resourceMetadata}"`] : []),
  ].join(", ")
}

function header(event: ConsoleRequestEvent, name: string): string | undefined {
  // H3 1 sets `event.req` to the Node request, whose headers are a plain object.
  for (const source of [event.req?.headers, event.headers]) {
    if (source && "get" in source && source.get instanceof Function) {
      const value = source.get(name)
      if (value !== null) return value
    }
  }
  const raw = event.node?.req?.headers?.[name]
  return Array.isArray(raw) ? raw[0] : raw
}

function method(event: ConsoleRequestEvent): string {
  return (event.method ?? event.req?.method ?? event.node?.req?.method ?? "GET").toUpperCase()
}

function pathname(event: ConsoleRequestEvent): string {
  const value = event.node?.req?.originalUrl || event.req?.url || event.node?.req?.url || "/"
  return new URL(value, "http://vitehub.local").pathname
}

/** The `Origin` of the request when `console.origins` lists it. */
export function listedConsoleOrigin(origin: string | null | undefined): string | undefined {
  return origin && installedConsoleOrigins().includes(origin) ? origin : undefined
}

/**
 * Whether a cross-origin request may reach a Console data route: `console.origins` lists its `Origin`, and the access
 * check accepted its `Authorization: Bearer` token (`access.via`: the Console token or an OAuth access token). A cookie
 * or a session never authorizes a cross-origin call.
 */
export function isConsoleCrossOriginBearerCall(request: Request, access: ConsoleAccess): boolean {
  return access.via !== undefined
    && listedConsoleOrigin(request.headers.get("origin")) !== undefined
    && /^Bearer\s+\S+/i.test(request.headers.get("authorization") ?? "")
}

/**
 * The CORS headers of a response to a listed origin. The Console reads `WWW-Authenticate` to find the OAuth resource
 * metadata, so it is exposed. No response sends `Access-Control-Allow-Credentials`.
 */
export function consoleCorsHeaders(origin: string): Record<string, string> {
  return { "access-control-allow-origin": origin, "access-control-expose-headers": "WWW-Authenticate", "vary": "Origin" }
}

/**
 * Add the CORS headers to a public document, such as OAuth metadata, when `console.origins` lists the request `Origin`.
 * With any listed origin, the response varies by `Origin`, so a shared cache keeps the answers apart.
 */
export function withListedConsoleOrigin(response: Response, request: Pick<Request, "headers">): Response {
  if (!installedConsoleOrigins().length) return response
  const origin = listedConsoleOrigin(request.headers.get("origin"))
  return withResponseHeaders(response, (headers) => {
    if (origin) for (const [name, value] of Object.entries(consoleCorsHeaders(origin))) headers.set(name, value)
    else headers.append("vary", "Origin")
  })
}

/**
 * Copy a response with changed headers. A Response from a fetch or from another realm can have immutable headers, so it
 * is copied. The copy names the status: srvx's Node.js `Response` reads no status from a `Response` passed as `init`.
 */
export function withResponseHeaders(response: Response, change: (headers: Headers) => void): Response {
  const headers = new Headers(response.headers)
  change(headers)
  return new Response(response.body, { headers, status: response.status, statusText: response.statusText })
}

/**
 * Answer a CORS preflight to a Console data route. A Nitro middleware calls it before app middleware and app Auth, which
 * would reject a preflight because it has no credentials. A listed origin gets `204`; another origin gets `403`.
 * Returns `undefined` for every other request.
 */
export function answerConsolePreflight(event: ConsoleRequestEvent): Response | undefined {
  if (method(event) !== "OPTIONS") return undefined
  const origin = header(event, "origin")
  if (!origin || !header(event, "access-control-request-method")) return undefined
  const path = pathname(event)
  if (!consoleDataRoutes.some(route => path.endsWith(route))) return undefined
  const allowed = listedConsoleOrigin(origin)
  if (!allowed) {
    return Response.json({ ...consoleDiagnosticBody("CONSOLE_ORIGIN_NOT_ALLOWED", `${origin} is not in console.origins for this app.`), ok: false, status: 403 }, {
      headers: { "cache-control": "no-store", "vary": "Origin", "x-content-type-options": "nosniff" },
      status: 403,
    })
  }
  return new Response(null, {
    headers: {
      ...consoleCorsHeaders(allowed),
      "access-control-allow-headers": consoleCorsAllowedHeaders,
      "access-control-allow-methods": "POST",
      "access-control-max-age": "600",
      "cache-control": "no-store",
      "vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    },
    status: 204,
  })
}

function withHeaders(response: Response, origin: string | undefined): Response {
  const challenge = response.status === 401 && !response.headers.has("www-authenticate")
  if (!origin && !challenge) return response
  return withResponseHeaders(response, (headers) => {
    if (challenge) headers.set("www-authenticate", consoleBearerChallenge())
    if (origin) for (const [name, value] of Object.entries(consoleCorsHeaders(origin))) headers.set(name, value)
  })
}

function errorResponse(error: unknown): Response {
  const value = Object(error)
  const rawStatus = Reflect.get(value, "statusCode") ?? Reflect.get(value, "status")
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500
  const code: unknown = Reflect.get(value, "code")
  const message: unknown = Reflect.get(value, "statusMessage")
  // Server failures keep their details out of the response, as the Console RPC does.
  const body = consoleDiagnosticBody(isConsoleDiagnosticCode(code) ? code : consoleStatusDiagnosticCode(status), status < 500 && String(message) === message ? message : undefined)
  return Response.json({ ...body, ok: false, status }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" }, status })
}

/**
 * Wrap a Console data route. A `401` gets `WWW-Authenticate: Bearer realm="vitehub-console"` when the route set no
 * challenge. A request from a listed origin gets `Access-Control-Allow-Origin` with that origin and `Vary: Origin`,
 * also on failures, so the Console can read the diagnostic. No route sends `Access-Control-Allow-Credentials`.
 */
export function withConsoleCors<TEvent extends ConsoleRequestEvent, TResult>(
  handler: (event: TEvent) => Promise<TResult | Response>,
): (event: TEvent) => Promise<TResult | Response> {
  return async (event) => {
    const origin = listedConsoleOrigin(header(event, "origin"))
    let result: TResult | Response
    try {
      result = await handler(event)
    }
    catch (error) {
      // H3 builds its own response for a thrown error, without the CORS headers. Only a listed origin needs them.
      if (!origin) throw error
      return withHeaders(errorResponse(error), origin)
    }
    if (isRuntimeResponse(result)) return withHeaders(result, origin)
    if (origin) {
      for (const [name, value] of Object.entries(consoleCorsHeaders(origin))) {
        event.res?.headers?.set(name, value)
        event.node?.res?.setHeader(name, value)
      }
    }
    return result
  }
}
