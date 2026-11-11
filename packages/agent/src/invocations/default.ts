// The default Agent Invocation journal with its libSQL driver: local SQLite or libSQL, or D1 on Cloudflare.
// libSQL loads on the first read or write, so a server that records no run does not load it.
// Hosts that know at build time that the journal is D1 or memory import `default-core` and pass no driver.
import { createDefaultAgentInvocations as createDefaultAgentInvocationsCore } from "./default-core.ts"

import type { AgentInvocations } from "../invocations.ts"
import type { DefaultAgentInvocationsOptions } from "./default-core.ts"

export {
  defaultAgentInvocationsAuthTokenEnv,
  defaultAgentInvocationsDatabase,
  defaultAgentInvocationsMetadataContent,
  defaultAgentInvocationsPath,
  defaultAgentInvocationsUrlEnv,
  resolveDefaultAgentInvocationsLocation,
} from "./default-core.ts"
export type {
  DefaultAgentInvocationsD1,
  DefaultAgentInvocationsD1Database,
  DefaultAgentInvocationsD1Statement,
  DefaultAgentInvocationsDatabase,
  DefaultAgentInvocationsLocation,
  DefaultAgentInvocationsOptions,
} from "./default-core.ts"

/**
 * The journal that ViteHub installs for Agents that set no journal, with the Console on or off.
 * It keeps prompts, messages, results, and tool input and output, like `configuration: "content"` with the
 * `defaultAgentInvocationsMetadataContent` attributes.
 * - Local SQLite at `.vitehub/data/agent-invocations.sqlite`, or the `databaseUrl` libSQL URL.
 * - D1 when `d1` is set and `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` is not.
 * - Memory on a Worker without D1 or a configured URL. An explicit `file:` URL throws `AGENT_R1029`.
 */
export function createDefaultAgentInvocations(options: DefaultAgentInvocationsOptions): AgentInvocations {
  return createDefaultAgentInvocationsCore({ ...options, libsql: async () => await import("./default-libsql.ts") })
}
