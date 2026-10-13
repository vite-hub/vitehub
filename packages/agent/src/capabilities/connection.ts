import { agentEnvAccess } from "@vite-hub/env/internal/agent"
import * as v from "valibot"

import { agentInvocationTraceIdContextKey } from "../trace.ts"
import { primitiveHandle } from "./internal.ts"

import type { EnvAccessContext } from "@vite-hub/env/bridge"
import type { AgentCapabilityContext } from "../types.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"
import { agentEnvIdentity } from "../internal/env-identity.ts"

export const connectionNameSchema: v.GenericSchema<unknown, string> = v.pipe(v.string(), v.trim(), v.minLength(1))

/** Structural view of the governed client that Connections exposes to server code. */
export interface AgentConnectionClient {
  call: (action: string, input?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
  fetch: (input: string | URL, init?: Pick<RequestInit, "headers" | "method" | "redirect" | "signal"> & { body?: string }) => Promise<Response>
}

interface AgentConnectionClientOptions {
  access: EnvAccessContext
  rejectApprovals?: boolean
  invocationId?: string
}

export function useAgentConnectionClient(context: AgentCapabilityContext & { [agentEnvIdentity]?: { name: string } }, name: string, capability: string, options: { rejectApprovals?: boolean } = {}): AgentConnectionClient {
  const handle = primitiveHandle(context, "connections")
  if (!handle) {
    throw agentDiagnostics.AGENT_R0080({ message: `[vitehub] ${capability}() uses Connection "${name}", so it requires Connections. Set vitehub({ connections: true }).` })
  }
  const primitive = v.safeParse(v.object({ runtime: v.function() }), handle)
  if (!primitive.success) {
    throw agentDiagnostics.AGENT_R0080({ message: `[vitehub] ${capability}() requires the connections primitive to expose runtime().` })
  }
  const runtime = v.safeParse(v.object({ client: v.function() }), primitive.output.runtime())
  if (!runtime.success) {
    throw agentDiagnostics.AGENT_R0080({ message: `[vitehub] ${capability}() requires the Connections runtime to expose client().` })
  }
  const connectionRuntime = runtime.output
  // Static tool inspection does not consume credentials. Mint authority only when a tool runs.
  let client: AgentConnectionClient | undefined
  function getClient(): AgentConnectionClient {
    if (client) return client
    const identity = context[agentEnvIdentity] ?? context.agentIdentity
    if (!identity) {
      throw agentDiagnostics.AGENT_R0080({ message: `[vitehub] ${capability}() requires a resolved Agent Definition identity.` })
    }
    const invocationId = optionalString(context.context.get(agentInvocationTraceIdContextKey))
    const clientOptions: AgentConnectionClientOptions = {
      ...options,
      // The host resolves the Agent Definition. Env creates its actor context here, never from a caller value.
      access: agentEnvAccess(identity, invocationId ? { invocationId } : {}),
      ...(invocationId ? { invocationId } : {}),
    }
    const value: unknown = connectionRuntime.client(name, clientOptions)
    const parsed = v.safeParse(v.object({ call: v.function(), fetch: v.function() }), value)
    if (!parsed.success) {
      throw agentDiagnostics.AGENT_R0080({ message: `[vitehub] ${capability}() requires a Connections client with call() and fetch().` })
    }
    // SAFETY: The structural schema checks the runtime client. Its methods match the Connections public contract.
    client = parsed.output as AgentConnectionClient
    return client
  }
  return {
    call: (...args) => getClient().call(...args),
    fetch: (...args) => getClient().fetch(...args),
  }
}

function optionalString(value: unknown): string | undefined {
  return v.is(v.string(), value) && value ? value : undefined
}
