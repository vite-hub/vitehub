import { defineGrant } from "@vite-hub/runtime/internal/grant"

import { consoleDiagnosticBody, type ConsoleDiagnosticCode } from "../diagnostics.ts"
import { consoleRequestError, consoleRequestURL, type ConsoleRequestEvent } from "./request.ts"

import type { ConsoleAuthorize } from "../../auth.ts"

/**
 * How the Console checks each request. Generated host output installs one policy for each server process.
 * - `local`: the development server, for `console: true` and development without an edge.
 * - `auth`: a ViteHub Auth Session. `check` is built on `withAuthorization()`.
 * - `cloudflare-access`: the Cloudflare Access application token.
 * - `host-managed`: the host-supplied `console.authorize` function.
 */
export type ConsoleAccessPolicy =
  | { mode: "local" }
  | { mode: "auth" | "cloudflare-access", check?: (event: ConsoleRequestEvent) => Promise<Response | undefined> }
  | { mode: "host-managed", authorize?: ConsoleAuthorize }

export type ConsoleAccessMode = ConsoleAccessPolicy["mode"]

/** The checked Console access that a guarded handler receives. Only `withConsoleAccess()` creates it. */
export interface ConsoleAccess {
  readonly mode: ConsoleAccessMode
}

/** A Console server handler that runs only after `withConsoleAccess()` accepts the request. */
export type ConsoleGuardedHandler<TEvent, TResult> = (event: TEvent, access: ConsoleAccess) => TResult | Promise<TResult>

/** The route that `withConsoleAccess()` returns for a handler. Route files use it to type their default export. */
export type ConsoleAccessRoute<THandler extends (event: never, access: ConsoleAccess) => unknown> = (event: Parameters<THandler>[0]) => Promise<Awaited<ReturnType<THandler>> | Response>

const policyKey: unique symbol = Symbol.for("vitehub.console.access")
// SAFETY: This module owns the process slot shared by separately bundled generated plugins and Console routes.
const scope = globalThis as typeof globalThis & { [policyKey]?: ConsoleAccessPolicy }
const consoleAccessGrant = defineGrant("vitehub.console.access", (mode: ConsoleAccessMode) => mode)
const checkedEvents = new WeakMap<object, ConsoleAccess>()
const modes = new Set<ConsoleAccessMode>(["auth", "cloudflare-access", "host-managed", "local"])

/** A JSON rejection with the Console diagnostic fields: `code`, `message` (the why), `fix`, and `docs`. */
function rejection(status: number, code: ConsoleDiagnosticCode, message?: string): Response {
  return Response.json({ ...consoleDiagnosticBody(code, message), ok: false, status }, {
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" },
    status,
  })
}

/** Install the Console access policy. Generated Console output calls this before it serves a request. */
export function installConsoleAccess(policy: ConsoleAccessPolicy): void {
  if (!(policy instanceof Object) || !modes.has(policy.mode)) {
    throw new TypeError("[vitehub] Console access requires a known access mode.")
  }
  if ("check" in policy && policy.check !== undefined && !(policy.check instanceof Function)) {
    throw new TypeError("[vitehub] Console access check must be a function.")
  }
  if ("authorize" in policy && policy.authorize !== undefined && !(policy.authorize instanceof Function)) {
    throw new TypeError("[vitehub] console.authorize must default-export a function.")
  }
  scope[policyKey] = Object.freeze({ ...policy })
}

function productionRuntime(): boolean {
  return globalThis.process?.env?.NODE_ENV === "production"
}

function webRequest(event: ConsoleRequestEvent): Request {
  if (event.req instanceof Request) return event.req
  const headers = new Headers()
  for (const [name, value] of Object.entries(event.node?.req?.headers ?? {})) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value)
  }
  return new Request(consoleRequestURL(event), { headers, method: event.method ?? event.req?.method ?? event.node?.req?.method ?? "GET" })
}

async function checkConsoleAccess(event: ConsoleRequestEvent): Promise<ConsoleAccess | Response> {
  const policy = scope[policyKey]
  if (!policy) return rejection(500, "CONSOLE_ACCESS_NOT_CONFIGURED", "Console access is not configured. The generated Console output did not install an access policy.")
  if (policy.mode === "local") {
    if (productionRuntime()) return rejection(403, "CONSOLE_DEVELOPMENT_ONLY")
  }
  else if (policy.mode === "host-managed") {
    if (!policy.authorize) {
      return rejection(500, "CONSOLE_AUTHORIZE_REQUIRED")
    }
    const result = await policy.authorize({ request: webRequest(event) })
    if (result instanceof Response) return result
    if (result !== true) return rejection(403, "CONSOLE_ACCESS_DENIED")
  }
  else {
    if (!policy.check) {
      return rejection(500, "CONSOLE_AUTH_NOT_CONFIGURED", policy.mode === "auth"
        ? "console: { access: \"auth\" } requires a discovered ViteHub Auth Definition."
        : "Cloudflare Access Console Auth is not configured.")
    }
    const response = await policy.check(event)
    if (response) return response
  }
  return consoleAccessGrant.issue(policy.mode, { mode: policy.mode })
}

/**
 * Name the manager of one Connections management request with the installed Console access policy.
 * The generated Connections actor module calls it, so Connections routes and Console data routes share one policy.
 * - `auth`: `sessionActor` reads the signed-in user as `user:<id>`.
 * - `local`, `host-managed`, and `cloudflare-access` have no user id. The manager is `user:<mode>`.
 * Returns the policy rejection when the policy rejects the request, so the Connections handler returns the same
 * Console diagnostic. Returns `403` with `CONSOLE_MANAGER_REQUIRED` when an `auth` session has no user id.
 */
export async function consoleConnectionsActor(
  event: ConsoleRequestEvent,
  sessionActor?: () => Promise<string | undefined>,
): Promise<string | Response> {
  const access = await checkConsoleAccess(event)
  if (access instanceof Response) return access
  if (access.mode !== "auth") return `user:${access.mode}`
  return (sessionActor ? await sessionActor() : undefined) ?? rejection(403, "CONSOLE_MANAGER_REQUIRED")
}

/**
 * Wraps a Console server handler so it runs only after the installed access policy accepts the request.
 * Otherwise the wrapper returns the rejection `Response`. Without an installed policy, it returns `500`.
 */
export function withConsoleAccess<TEvent extends ConsoleRequestEvent, TResult>(
  handler: ConsoleGuardedHandler<TEvent, TResult>,
): (event: TEvent) => Promise<TResult | Response> {
  if (!(handler instanceof Function)) throw new TypeError("[vitehub] withConsoleAccess() requires a handler function.")
  return async (event) => {
    const bound = checkedEvents.get(event)
    if (bound && consoleAccessGrant.isValid(bound)) return handler(event, bound)
    const access = await checkConsoleAccess(event)
    if (access instanceof Response) return access
    checkedEvents.set(event, access)
    return handler(event, access)
  }
}

/**
 * Bind a checked Console access to an internal event, such as one Console RPC operation.
 * A guarded handler that receives this event uses the bound access. Rejects an access that `withConsoleAccess()` did not create.
 */
export function bindConsoleAccess<TEvent extends ConsoleRequestEvent>(access: ConsoleAccess, event: TEvent): TEvent {
  if (!consoleAccessGrant.isValid(access)) throw consoleRequestError(403, "This Console access was not created by the access check.")
  if (checkedEvents.has(event)) throw consoleRequestError(500, "Console access is already bound to this request.")
  checkedEvents.set(event, access)
  return event
}
