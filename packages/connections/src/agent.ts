import { useConnectionsRuntime } from "./runtime/state.ts"

import type { ConnectionsRuntime } from "./runtime/core.ts"

/** Handle that Agent Capabilities receive as the `connections` primitive. */
export interface ConnectionsAgentPrimitive {
  runtime: () => ConnectionsRuntime
}

export const connections: ConnectionsAgentPrimitive = {
  runtime: useConnectionsRuntime,
}
