import generated from "#vitehub/connections/runtime"

import { resolveConnectionActor } from "../actor.ts"
import { connectionError } from "../errors.ts"
import { createConnectionsRuntime } from "./core.ts"

import type { ConnectionName } from "../registry-types.ts"
import type { ConnectionCallResult, ConnectionClient, ConnectionEffect, ConnectionOperation, UseConnectionOptions } from "../types.ts"
import type { ConnectionsRuntime } from "./core.ts"

let override: ConnectionsRuntime | undefined
let runtime: ConnectionsRuntime | undefined

/** Replaces the runtime. Tests and hosts without generated output use it. */
export function setConnectionsRuntime(value: ConnectionsRuntime | undefined): void {
  override = value
}

/** Returns the Connections runtime for this server. */
export function useConnectionsRuntime(): ConnectionsRuntime {
  if (override) return override
  runtime ??= createConnectionsRuntime({
    database: generated.database,
    encryptionKey: generated.encryptionKey,
    registry: generated.registry,
  })
  return runtime
}

/**
 * Returns a client for a Connection. Calls check access, refresh tokens, and record activity.
 * Pass `event` in routes so the route is the actor.
 */
export function useConnection<const TDryRun extends boolean | undefined = undefined>(
  name: ConnectionName,
  options: UseConnectionOptions<TDryRun> = {},
): ConnectionClient<TDryRun> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JavaScript callers can pass any value as the Connection name.
  if (typeof name !== "string" || !name.trim()) throw connectionError("invalid", { path: "name" })
  const callOptions = () => ({
    actor: resolveConnectionActor(options),
    audit: options.audit ?? "changes",
    dryRun: options.dryRun === true,
    event: options.event,
    trace: options.trace,
  })
  return {
    name,
    call: <TInput, TOutput, TEffect extends ConnectionEffect>(operation: ConnectionOperation<TInput, TOutput, TEffect>, input: TInput) =>
      // SAFETY: the runtime returns `ConnectionSkipped` only for write Operations in dry run, as `ConnectionCallResult` models.
      useConnectionsRuntime().call(name, operation, input, callOptions()) as Promise<ConnectionCallResult<TOutput, TEffect, TDryRun>>,
    fetch: (url, init) => useConnectionsRuntime().fetch(name, url, init, callOptions()),
    status: () => useConnectionsRuntime().inspect(name, options.event),
  }
}
