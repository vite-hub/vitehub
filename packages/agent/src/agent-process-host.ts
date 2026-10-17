import type { SqliteAgentStateExtension } from "./state/sqlite.ts"
import { isRuntimeRecord } from "./internal/runtime-type.ts"

const contributionKey = Symbol.for("vitehub.agentProcessHost")
const intakeKey = Symbol.for("vitehub.agentProcessHostIntakes")

/** Inputs that ViteHub supplies when it starts a contributed process host for a discovered Agent. */
export interface AgentProcessHostContext {
  /** Discovered Agent name. */
  agentName: string
  /** The discovered definition, with colocated instructions and Skills applied. */
  agent: object
  /** Opens tables for an extension in the Agent State database. */
  state: { extension(name: string): SqliteAgentStateExtension }
  /** Directory that this host owns exclusively for invocation records and provider sessions. */
  dataDir: string
}

interface AgentProcessHostHealth {
  status: "healthy" | "degraded"
  [key: string]: unknown
}

/** A long-running host for one Agent, such as the Babysitter's PR reconciler. */
export interface AgentProcessHostInstance {
  start(): void
  close(): Promise<void>
  wake(reason?: string): void
  status(): "starting" | "accepting" | "draining" | "drained" | "failed"
  health(): Promise<AgentProcessHostHealth>
}

/** Attached to an Agent Definition by a preset that needs a process host on Node. */
export interface AgentProcessHostContribution {
  create(context: AgentProcessHostContext): Promise<AgentProcessHostInstance>
}

/** Returns the definition with a process host contribution. It survives `extends` and preset options. */
const contributionsKey = Symbol.for("vitehub.agentProcessHostContributions")

/** Known contributions by their marker object, shared by every copy of this module in a process. */
function contributions(): WeakMap<object, AgentProcessHostContribution> {
  const scope: Record<PropertyKey, unknown> = globalThis
  const existing = scope[contributionsKey]
  if (existing instanceof WeakMap) return existing
  const created = new WeakMap<object, AgentProcessHostContribution>()
  scope[contributionsKey] = created
  return created
}

export function withAgentProcessHost<T extends object>(definition: T, contribution: AgentProcessHostContribution): T {
  // A plain marker object survives definition layering; the typed contribution stays in the registry.
  const marker = Object.freeze({})
  contributions().set(marker, contribution)
  Object.defineProperty(definition, contributionKey, { configurable: true, enumerable: false, value: marker, writable: false })
  return definition
}

export function getAgentProcessHostContribution(agent: unknown): AgentProcessHostContribution | undefined {
  if (!isRuntimeRecord(agent)) return undefined
  const marker = agent[contributionKey]
  return isRuntimeRecord(marker) ? contributions().get(marker) : undefined
}

/** Handles a verified webhook delivery for a running host. */
export type AgentProcessHostIntake = (delivery: { deliveryId: string, event: string, payload: unknown }) => Promise<Response>

function intakes(): Map<string, AgentProcessHostIntake> {
  const scope: Record<PropertyKey, unknown> = globalThis
  // One map per process, also when a bundle loads this module more than once.
  const existing = scope[intakeKey]
  if (existing instanceof Map) return existing
  const created = new Map<string, AgentProcessHostIntake>()
  scope[intakeKey] = created
  return created
}

export function registerAgentProcessHostIntake(agentName: string, intake: AgentProcessHostIntake | undefined): void {
  if (intake) intakes().set(agentName, intake)
  else intakes().delete(agentName)
}

export function agentProcessHostIntake(agentName: string): AgentProcessHostIntake | undefined {
  return intakes().get(agentName)
}
