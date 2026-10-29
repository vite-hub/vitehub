import { getConnectionsRuntime } from "./runtime/state.ts"
import { useChatGPTCredential } from "./internal/agent-credential.ts"
import type { UseChatGPTCredential } from "./internal/agent-credential.ts"

import type { ConnectionsRuntime } from "./runtime.ts"

/** Handle that Agent Capabilities receive as the `connections` primitive. */
export interface ConnectionsAgentPrimitive {
  runtime: () => ConnectionsRuntime
  useChatGPTCredential: UseChatGPTCredential
}

export const connections: ConnectionsAgentPrimitive = {
  runtime: getConnectionsRuntime,
  useChatGPTCredential: (name, options, use) => useChatGPTCredential(getConnectionsRuntime())(name, options, use),
}

export type { ChatGPTCredential, UseChatGPTCredential } from "./internal/agent-credential.ts"
