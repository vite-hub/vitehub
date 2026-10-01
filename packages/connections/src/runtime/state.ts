import discoveredRegistry, { database } from "#vitehub/connections/registry"
import { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import * as v from "valibot"

import { ConnectionError } from "../errors.ts"
import { createConnectionsRuntime } from "../runtime.ts"
import { createDatabaseConnectionStore } from "../store.ts"

import type { ConnectionDefinitionName, ConnectionRegistryClient } from "../registry-types.ts"
import type { ConnectionRuntimeClient, ConnectionsRuntime, ConnectionsRuntimeOptions } from "../runtime.ts"
import type { ConnectionStore } from "../store.ts"
import { CONNECTION_NAME_MAX_LENGTH } from "../types.ts"
import type { ConnectionClient, ConnectionFetchInit, UseConnectionOptions } from "../types.ts"

let runtime: ConnectionsRuntime | undefined

/** Replace the Connections runtime, for example with a custom store in tests. Pass `undefined` to reset it. */
export function setConnectionsRuntime(options: ConnectionsRuntimeOptions | undefined): void {
  runtime = options ? createConnectionsRuntime(options) : undefined
}

function decodeKey(value: string): Uint8Array {
  if (/^[a-f0-9]{64}$/i.test(value)) return Uint8Array.from(value.match(/../g)!, byte => Number.parseInt(byte, 16))
  try {
    return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0))
  }
  catch {
    return new Uint8Array()
  }
}

function readEncryptionKey(): Uint8Array {
  const processEnv = v.safeParse(v.object({ process: v.optional(v.object({ env: v.optional(v.object({ VITEHUB_CONNECTIONS_KEY: v.optional(v.string()) })) })) }), globalThis)
  const cloudflareValue = getActiveCloudflareEnv()?.VITEHUB_CONNECTIONS_KEY
  const parsedCloudflareValue = v.safeParse(v.string(), cloudflareValue)
  const value = (processEnv.success ? processEnv.output.process?.env?.VITEHUB_CONNECTIONS_KEY : undefined) ?? (parsedCloudflareValue.success ? parsedCloudflareValue.output : undefined)
  const key = value ? decodeKey(value.trim()) : undefined
  if (key?.byteLength !== 32) {
    throw new ConnectionError("invalid", "Connections need VITEHUB_CONNECTIONS_KEY with 32 random bytes as base64 or hex. Create one with `openssl rand -base64 32`.")
  }
  return key
}

async function defaultStore(): Promise<ConnectionStore> {
  if (!database) {
    throw new ConnectionError("invalid", "Connections need the ViteHub Database. Enable `database` in vitehub(), or call setConnectionsRuntime() with a store.")
  }
  return createDatabaseConnectionStore({ db: await database(), encryptionKey: readEncryptionKey() })
}

/** The active Connections runtime. */
export function getConnectionsRuntime(): ConnectionsRuntime {
  return runtime ??= createConnectionsRuntime({ definitions: discoveredRegistry, store: defaultStore })
}

function methodProxy(client: ConnectionRuntimeClient, path: string): unknown {
  const call = (input?: unknown, options?: { signal?: AbortSignal }) => client.call(path, input, options)
  return new Proxy(call, {
    get(_target, property) {
      const key = v.safeParse(v.string(), property)
      if (!key.success || key.output === "then" || key.output === "toJSON") return undefined
      return methodProxy(client, `${path}.${key.output}`)
    },
  })
}

/**
 * Use a Connection. The client calls provider API methods with the stored token,
 * applies the Connection access policy, and records activity.
 */
export function useConnection<const TName extends ConnectionDefinitionName, const TDryRun extends boolean = false>(name: TName, options?: Omit<UseConnectionOptions, "dryRun"> & { dryRun?: TDryRun }): ConnectionRegistryClient<TName, TDryRun>
export function useConnection<TName extends string>(name: string extends TName ? TName : never, options?: UseConnectionOptions): ConnectionClient
export function useConnection(name: string, options: UseConnectionOptions = {}): ConnectionClient {
  if (!v.safeParse(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(CONNECTION_NAME_MAX_LENGTH)), name).success) throw new ConnectionError("invalid", "`useConnection()` requires a Connection name of at most 501 characters.")
  let client: ConnectionRuntimeClient | undefined
  const resolveClient = () => (client ??= getConnectionsRuntime().client(name, options))
  // SAFETY: The get trap supplies fetch and every dynamic API method required by ConnectionClient.
  return new Proxy({ name } as ConnectionClient, {
    get(target, property) {
      if (property === "name") return target.name
      if (property === "fetch") return (input: string | URL, init?: ConnectionFetchInit) => resolveClient().fetch(input, init)
      const key = v.safeParse(v.string(), property)
      if (!key.success || key.output === "then" || key.output === "toJSON") return undefined
      return methodProxy({
        call: (action, input, callOptions) => resolveClient().call(action, input, callOptions),
        fetch: (input, init) => resolveClient().fetch(input, init),
      }, key.output)
    },
  })
}
