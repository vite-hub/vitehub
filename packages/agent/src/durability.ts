import { classifySqliteUrl } from "@vite-hub/runtime/durability"

import { agentJournalBesideState, defaultAgentInvocationsPath, defaultAgentInvocationsUrlEnv } from "./invocations/default-location.ts"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

/**
 * What the build passes to `agentStateDurability()`. `url` is a `file:` or `:memory:` URL, or `remote` for a remote
 * libSQL server, so no credential reaches the server bundle.
 */
export interface AgentStateDurabilityInput {
  provider: "cloudflare" | "libsql" | "memory"
  url?: string
}

/** The durability of Agent state. `VITEHUB_AGENT_STATE_URL` replaces the configured libSQL URL at boot. */
export function agentStateDurability(input: AgentStateDurabilityInput, { env }: DurabilityContext): Durability[] {
  if (input.provider === "cloudflare") {
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

/**
 * What the build passes to `agentInvocationsDurability()`. `url` follows the same rule as Agent state. `stateUrl` is
 * the `file:` Agent State URL that the default journal goes next to. `defaultJournal` marks the default journal in a
 * Database, which `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` moves at boot.
 */
export type AgentInvocationsDurabilityInput =
  | { store: "database", database?: string, defaultJournal?: true }
  | { store: "d1" }
  | { store: "file", stateUrl?: string, url?: string }
  | { store: "memory" }

const journalFix = `Set ${defaultAgentInvocationsUrlEnv} to a remote libSQL URL, or set agent.invocations to "database" with a shared Database.`

/** The durability of the Agent Invocation journal. `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` moves the default journal at boot. */
export function agentInvocationsDurability(input: AgentInvocationsDurabilityInput, context: DurabilityContext): Durability[] {
  if (input.store === "d1") return [{ primitive: "agent-invocations", store: "d1", scope: "shared", reason: "A Cloudflare D1 table." }]
  if (input.store === "memory") {
    return [{ primitive: "agent-invocations", store: "memory", scope: "process", reason: "The journal lives in the memory of this process.", fix: journalFix }]
  }
  const runtimeUrl = context.env[defaultAgentInvocationsUrlEnv]?.trim()
  if (input.store === "database" && !(input.defaultJournal && runtimeUrl)) {
    const name = input.database ?? "default"
    const database = context.find("database", name)
    if (!database) return [{ primitive: "agent-invocations", store: "database", scope: "process", reason: `The ${name} Database is off.`, fix: journalFix }]
    return [{ primitive: "agent-invocations", store: `database (${database.store})`, scope: database.scope, reason: `Rows in the ${name} Database. ${database.reason}`, ...(database.fix ? { fix: database.fix } : {}) }]
  }
  const file: { stateUrl?: string, url?: string } = input.store === "file" ? input : {}
  const url = runtimeUrl || file.url || agentJournalBesideState(file.stateUrl, context.env)?.url || `file:${defaultAgentInvocationsPath}`
  const sqlite = classifySqliteUrl(url)
  return [{ primitive: "agent-invocations", ...sqlite, ...(sqlite.scope === "shared" ? {} : { fix: journalFix }) }]
}

/** What the build passes to `agentRecoveryDurability()`. `sweep` is true when the server sweeps under a Database Lease. */
export interface AgentRecoveryDurabilityInput {
  sweep: boolean
}

const recoveryFix = "Configure a default or sole Database so each server sweeps the journal under the Lease `agent-recovery:<agent>`."

/** How a server finds the Invocations that a stopped server left running. */
export function agentRecoveryDurability(input: AgentRecoveryDurabilityInput, context: DurabilityContext): Durability[] {
  const database = input.sweep ? context.find("database", "default", true) : undefined
  if (!database) {
    return [{ primitive: "agent-recovery", store: "startup", scope: "process", reason: "No periodic journal recovery sweep runs.", fix: recoveryFix }]
  }
  return [{
    primitive: "agent-recovery",
    store: `lease (${database.store})`,
    scope: database.scope,
    reason: `One server at a time sweeps the journal every 15 seconds, under a Lease in the ${database.name ?? "default"} Database. ${database.reason}`,
    ...(database.fix ? { fix: database.fix } : {}),
  }]
}

/** What the build passes to `agentProcessHostDurability()`. `lease` is true when the hosts run under a Database Lease. */
export interface AgentProcessHostDurabilityInput {
  lease: boolean
}

const processHostFix = "Add a Database named `default`, so each Agent runs its process host on one server at a time, under the Lease `agent-process-host:<agent>`."

/** How many servers run the process host of an Agent, such as the Babysitter. */
export function agentProcessHostDurability(input: AgentProcessHostDurabilityInput, context: DurabilityContext): Durability[] {
  const database = input.lease ? context.find("database") : undefined
  if (!database) {
    return [{ primitive: "agent-process-host", store: "process", scope: "process", reason: "Every server runs its own process host for each Agent.", fix: processHostFix }]
  }
  return [{
    primitive: "agent-process-host",
    store: `lease (${database.store})`,
    scope: database.scope,
    reason: `One server at a time runs the process host of each Agent, under a Lease in the default Database. Another server takes over within about 30 seconds. ${database.reason}`,
    ...(database.fix ? { fix: database.fix } : {}),
  }]
}

/**
 * The durability of web chat streams with `resumable.scope: "shared"`. They live in the database of the journal, so
 * they are as shared as the journal. A journal in memory cannot hold them: such a route fails, and the row says `process`.
 */
export function agentChatStreamsDurability(input: AgentInvocationsDurabilityInput, context: DurabilityContext): Durability[] {
  return agentInvocationsDurability(input, context).map(({ primitive: _primitive, reason, ...journal }) => ({
    ...journal,
    primitive: "agent-chat-streams",
    reason: input.store === "memory"
      ? "Shared resumable chat streams need a journal in a database. This journal lives in memory, so only `resumable.scope: \"process\"` works."
      : `Resumable chat streams with \`scope: "shared"\` use the journal database. ${reason}`,
  }))
}
