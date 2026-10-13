import * as v from "valibot"

import type { ConnectionsRuntime } from "../runtime.ts"

/**
 * Authenticates one management request and returns the manager as `user:<id>`.
 * Return `undefined` to deny the request.
 */
export type ConnectionsActor = (request: Request, event?: unknown) => string | undefined | Promise<string | undefined>

/**
 * Access policy of the Connections management routes.
 *
 * - A {@link ConnectionsActor} function checks every request.
 * - `"development"` allows every request as `user:local` on a development server
 *   (`NODE_ENV=development`). Any other runtime gets `500` with `CONNECTION_AUTH_REQUIRED`.
 */
export type ConnectionsAccessPolicy = ConnectionsActor | "development"

const connectionsAccessBrand: unique symbol = Symbol("vitehub.connectionsAccess")

/**
 * Proof that one request passed the Connections access check. Only {@link checkConnectionsAccess}
 * creates it. It is frozen, bound to its request, and valid only while that request runs. Never store it.
 */
export interface ConnectionsAccess {
  readonly [connectionsAccessBrand]: true
  /** The manager that the policy accepted, as `user:<id>`. */
  readonly actor: string
  readonly request: Request
}

/** Result of the access check: the access of the request, or the rejection response. */
export type ConnectionsAccessCheck =
  | { readonly access: ConnectionsAccess, readonly rejection?: undefined }
  | { readonly access?: undefined, readonly rejection: Response }

const grants = new WeakMap<ConnectionsAccess, () => ConnectionsRuntime>()

function reject(status: number, code: string, message: string): ConnectionsAccessCheck {
  return {
    rejection: new Response(JSON.stringify({ error: { code, message } }), {
      headers: { "cache-control": "no-store", "content-type": "application/json" },
      status,
    }),
  }
}

const managerSchema = v.pipe(v.string(), v.regex(/^user:[^\s]{1,256}$/))
// Worker runtimes can run without `process`.
const developmentProcessSchema = v.looseObject({ env: v.looseObject({ NODE_ENV: v.literal("development") }) })

/**
 * Runs the access policy for one request. Only a granted access can reach the Connections runtime
 * through {@link connectionsRuntimeFor}.
 */
export async function checkConnectionsAccess(
  // JavaScript callers can omit the policy.
  policy: ConnectionsAccessPolicy | undefined,
  request: Request,
  event: unknown,
  runtime: () => ConnectionsRuntime,
): Promise<ConnectionsAccessCheck> {
  let actor: unknown
  if (policy === "development") {
    if (!v.is(developmentProcessSchema, globalThis.process)) {
      return reject(500, "CONNECTION_AUTH_REQUIRED", "Connections management requires Auth outside local development. Configure an actor module or Console Auth.")
    }
    actor = "user:local"
  }
  else if (v.is(v.function(), policy)) {
    actor = await policy(request, event)
  }
  else {
    return reject(500, "CONNECTION_AUTH_REQUIRED", "createConnectionsHandler() requires an actor policy.")
  }
  const manager = v.safeParse(managerSchema, actor)
  if (!manager.success) {
    return reject(403, "CONNECTION_FORBIDDEN", "An authenticated management user is required.")
  }
  const access: ConnectionsAccess = Object.freeze({ [connectionsAccessBrand]: true as const, actor: manager.output, request })
  grants.set(access, runtime)
  return { access }
}

/**
 * Returns the Connections runtime factory for a checked request. Throws for a missing or forged access,
 * so a route body cannot read or change Connection state without the check.
 */
export function connectionsRuntimeFor(access: ConnectionsAccess): () => ConnectionsRuntime {
  const runtime = grants.get(access)
  if (!runtime) throw new TypeError("[vitehub] Connections management requires the access of a checked request.")
  return runtime
}
