import { defineOperation } from "@vite-hub/internal/operations"
import { resolvePublicUrl } from "@vite-hub/runtime"
import * as v from "valibot"

import { isConnectionError } from "./errors.ts"
import { connectionsErrorDiagnostics } from "./error-diagnostics.ts"
import { errorStatus } from "./internal/http-routes.ts"
import { CONNECTIONS_ROUTE } from "./route.ts"
import { connectionNameSchema } from "./types.ts"

import type { AnyOperation, OperationContext, OperationDefinition } from "@vite-hub/internal/operations"
import type { ConnectionInspection, ConnectionStatus } from "./types.ts"

/** One row of the Console Connections list. Times are milliseconds since the epoch. */
export interface ConnectionsConsoleItem {
  id: string
  account?: string
  connectedAt?: number
  credential: ConnectionInspection["credential"]
  expiresAt?: number
  keyError?: ConnectionInspection["keyError"]
  /** Declared scopes that the grant lacks. */
  missingScopes: string[]
  name: string
  provider: string
  refreshedAt?: number
  status: ConnectionStatus
}

const operationRpcPath = "/_vitehub/rpc"

async function runtime() {
  return (await import("./runtime/state.ts")).getConnectionsRuntime()
}

function manager(context: OperationContext): string {
  return `user:${context.user?.id ?? "local"}`
}

async function withStatus<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  }
  catch (error) {
    if (isConnectionError(error)) throw Object.assign(error, { status: errorStatus(error) })
    throw error
  }
}

function time(value: string | undefined): number | undefined {
  return value ? Date.parse(value) : undefined
}

function item(connection: ConnectionInspection): ConnectionsConsoleItem {
  const account = connection.account?.email ?? connection.account?.id
  return {
    id: connection.name,
    ...(account ? { account } : {}),
    ...(connection.connectedAt ? { connectedAt: time(connection.connectedAt) } : {}),
    credential: connection.credential,
    ...(connection.expiresAt ? { expiresAt: time(connection.expiresAt) } : {}),
    ...(connection.keyError ? { keyError: connection.keyError } : {}),
    missingScopes: connection.scopes.missing,
    name: connection.name,
    provider: connection.provider,
    ...(connection.refreshedAt ? { refreshedAt: time(connection.refreshedAt) } : {}),
    status: connection.status,
  }
}

function defineConnectionsOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section">): OperationDefinition<Input, Output> {
  return defineOperation({ ...definition, run: (input, context) => withStatus(async () => await definition.run(input, context)), section: "connections" })
}

const name = v.pipe(connectionNameSchema, v.description("The Connection name, such as github or portal:acme."))

const list = defineConnectionsOperation<Record<string, never>, ConnectionsConsoleItem[]>({
  description: "List the Connections of the app with their status and account.",
  input: v.object({}),
  kind: "read",
  name: "connections.list",
  run: async () => (await (await runtime()).list()).map(item),
  user: false,
})

const connect = defineConnectionsOperation<{ name: string }, { expiresAt: string, url: string }>({
  description: "Start the OAuth sign-in of a Connection. Open the returned provider URL in a browser within 10 minutes; the app's callback stores the grant.",
  input: v.object({ name }),
  kind: "write",
  mcp: { title: "Connect a Connection" },
  name: "connections.connect",
  run: async (input, context) => {
    const request = context.request
    const origin = request ? resolvePublicUrl({ request }) : undefined
    if (!request || !origin) throw connectionsErrorDiagnostics.CONNECTIONS_ORIGIN_REJECTED({ problem: "origin" })
    const { pathname } = new URL(request.url)
    const base = pathname.endsWith(operationRpcPath) ? pathname.slice(0, -operationRpcPath.length) : ""
    const { expiresAt, url } = await (await runtime()).authorize({
      actor: manager(context),
      name: input.name,
      redirectUri: `${new URL(origin).origin}${base}${CONNECTIONS_ROUTE}/callback`,
      via: "console",
    })
    return { expiresAt, url }
  },
})

const revoke = defineConnectionsOperation<{ name: string }, ConnectionsConsoleItem>({
  description: "Revoke the grant of a Connection at the provider and delete it from the app. Calls fail until someone connects it again.",
  input: v.object({ name }),
  kind: "destructive",
  name: "connections.revoke",
  run: async (input, context) => item(await (await runtime()).revoke({ actor: manager(context), name: input.name })),
})

/** The `connections.*` operations that the Console and MCP run: list, connect, and revoke. */
export const connectionsOperations: readonly AnyOperation[] = [list, connect, revoke]
