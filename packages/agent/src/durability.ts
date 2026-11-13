import { classifySqliteUrl } from "@vite-hub/runtime/durability"

import { defaultAgentInvocationsPath, defaultAgentInvocationsUrlEnv } from "./invocations/default-location.ts"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

/**
 * What the build passes to `agentStateDurability()`. `url` is a `file:` or `:memory:` URL, or `remote` for a remote
 * libSQL server, so no credential reaches the server bundle.
 */
export interface AgentStateDurabilityInput {
  provider: string
  url?: string
}

/** The durability of Agent state. `VITEHUB_AGENT_STATE_URL` replaces the configured libSQL URL at boot. */
export function agentStateDurability(input: AgentStateDurabilityInput, { env }: DurabilityContext): Durability[] {
  if (input.provider === "cloudflare" || input.provider === "cloudflare-agents") {
    return [{ primitive: "agent-state", store: "cloudflare", scope: "shared", reason: "Durable Objects keep each Agent's state." }]
  }
  if (input.provider === "memory") {
    return [{ primitive: "agent-state", store: "memory", scope: "process", reason: "Agent state lives in the memory of this process.", fix: "Set VITEHUB_AGENT_STATE_URL to a remote libSQL URL." }]
  }
  const url = env.VITEHUB_AGENT_STATE_URL?.trim() || input.url
  if (!url) {
    return [{ primitive: "agent-state", store: "libsql", scope: "process", reason: "No Agent state URL is set, so Agents cannot keep state.", fix: "Set VITEHUB_AGENT_STATE_URL to a remote libSQL URL." }]
  }
  const sqlite = classifySqliteUrl(url)
  return [{ primitive: "agent-state", ...sqlite, ...(sqlite.scope === "shared" ? {} : { fix: "Set VITEHUB_AGENT_STATE_URL to a remote libSQL URL." }) }]
}

/** What the build passes to `agentInvocationsDurability()`. `url` follows the same rule as Agent state. */
export type AgentInvocationsDurabilityInput =
  | { store: "database", database?: string }
  | { store: "d1" }
  | { store: "file", url?: string }
  | { store: "memory" }

const journalFix = `Set ${defaultAgentInvocationsUrlEnv} to a remote libSQL URL, or set agent.invocations to "database" with a shared Database.`

/** The durability of the Agent Invocation journal. `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` moves the default journal at boot. */
export function agentInvocationsDurability(input: AgentInvocationsDurabilityInput, context: DurabilityContext): Durability[] {
  if (input.store === "d1") return [{ primitive: "agent-invocations", store: "d1", scope: "shared", reason: "A Cloudflare D1 table." }]
  if (input.store === "memory") {
    return [{ primitive: "agent-invocations", store: "memory", scope: "process", reason: "The journal lives in the memory of this process.", fix: journalFix }]
  }
  if (input.store === "database") {
    const name = input.database ?? "default"
    const database = context.find("database", name)
    if (!database) return [{ primitive: "agent-invocations", store: "database", scope: "process", reason: `The ${name} Database is off.`, fix: journalFix }]
    return [{ primitive: "agent-invocations", store: `database (${database.store})`, scope: database.scope, reason: `Rows in the ${name} Database. ${database.reason}`, ...(database.fix ? { fix: database.fix } : {}) }]
  }
  const url = context.env[defaultAgentInvocationsUrlEnv]?.trim() || input.url || `file:${defaultAgentInvocationsPath}`
  const sqlite = classifySqliteUrl(url)
  return [{ primitive: "agent-invocations", ...sqlite, ...(sqlite.scope === "shared" ? {} : { fix: journalFix }) }]
}
