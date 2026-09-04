import { consoleInvocationsFallbackKey, resolveConsoleInvocations } from "../../internal.ts"
import { installConsoleInvocations } from "./invocations.ts"

import type { AgentInvocations } from "@vite-hub/agent"

export const consoleAgentsKey: unique symbol = Symbol.for("vitehub.console.agents")
export const consoleAgentDefinitionsKey: unique symbol = Symbol.for("vitehub.console.agent-definitions")
export const consoleInvokeEnabledKey: unique symbol = Symbol.for("vitehub.console.invoke-enabled")

export type ConsoleAgentDefinitionEntry = {
  definition: unknown
  fallbackName: string
}

export type ConsoleAgentDefinitionInstallation =
  | { invocations: AgentInvocations, projectRoot?: never }
  | { invocations?: never, invoke?: boolean, projectRoot: string }

type ConsoleAgentInvocations = AgentInvocations & {
  [consoleAgentDefinitionsKey]?: ReadonlyMap<string, Record<string, unknown>>
  [consoleAgentsKey]?: readonly string[]
  [consoleInvokeEnabledKey]?: boolean
}

const consoleAssignedInvocations = new WeakMap<object, AgentInvocations>()

type ResolvedConsoleAgentDefinition = {
  agent?: Record<string, unknown>
  fallbackName: string
}

function resolveConsoleAgentDefinition(
  entry: ConsoleAgentDefinitionEntry,
): ResolvedConsoleAgentDefinition {
  const { definition, fallbackName } = entry
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Generated plugins can import arbitrary JavaScript definitions, so inspect their runtime shape at this boundary.
  // SAFETY: The object check establishes the string-keyed record needed to inspect a generated module namespace.
  const module = definition && typeof definition === "object" ? definition as Record<string, unknown> : undefined
  let agent = module
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Generated plugins can provide an arbitrary default export, so inspect its runtime shape at this boundary.
  if (module?.default && typeof module.default === "object") {
    // SAFETY: The object check establishes the string-keyed record needed to inspect a generated module default export.
    agent = module.default as Record<string, unknown>
  }
  return { agent, fallbackName }
}

function explicitAgentInvocations(agent: Record<string, unknown> | undefined): AgentInvocations | undefined {
  if (!agent || Reflect.get(agent, consoleInvocationsFallbackKey) === true) return undefined
  const assigned = consoleAssignedInvocations.get(agent)
  const invocations = agent.invocations
  if (invocations === undefined || invocations === assigned) return undefined
  // SAFETY: Agent Definitions own this field; Console passes the discovered value only to the Agent invocation journal boundary that defined it.
  return invocations as AgentInvocations
}

function resolveConsoleAgentInvocations(
  definitions: readonly ResolvedConsoleAgentDefinition[],
  installation: ConsoleAgentDefinitionInstallation,
): AgentInvocations {
  if (installation.invocations) return installation.invocations
  const configured = [...new Set(definitions.map(({ agent }) => explicitAgentInvocations(agent)).filter(Boolean))]
  if (configured.length > 1) {
    throw new TypeError("[vitehub] Console cannot inspect multiple Agent invocation journals. Configure one shared journal for the discovered Agent Definitions.")
  }
  return installConsoleInvocations(installation.projectRoot, configured[0])
}

export function installConsoleAgents(
  agentNames: readonly string[],
  invocations: AgentInvocations,
): readonly string[] {
  const agents = [...new Set(agentNames.map(name => name.trim()).filter(Boolean))].sort()
  // SAFETY: This intersection only attaches console-owned metadata to the Agent invocation journal.
  const consoleInvocations = invocations as ConsoleAgentInvocations
  consoleInvocations[consoleAgentsKey] = agents
  return agents
}

export function installConsoleAgentDefinitions(
  entries: readonly ConsoleAgentDefinitionEntry[],
  installation: ConsoleAgentDefinitionInstallation,
): readonly string[] {
  const definitions = entries.map(resolveConsoleAgentDefinition)
  const invocations = resolveConsoleAgentInvocations(definitions, installation)
  const names = definitions.map(({ agent, fallbackName }) => {
    if (agent && Reflect.get(agent, consoleInvocationsFallbackKey) !== true) {
      const assigned = consoleAssignedInvocations.get(agent)
      if (agent.invocations === undefined || agent.invocations === assigned) {
        agent.invocations = invocations
        consoleAssignedInvocations.set(agent, invocations)
      }
      else if (assigned) {
        consoleAssignedInvocations.delete(agent)
      }
    }
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Agent Definitions may come from untyped JavaScript, so verify the identity before installing it.
    return typeof agent?.name === "string" && agent.name.trim() ? agent.name : fallbackName
  })
  const installed = installConsoleAgents(names, invocations)
  const consoleInvocations = invocations as ConsoleAgentInvocations
  consoleInvocations[consoleAgentDefinitionsKey] = new Map(definitions.flatMap((definition, index) => {
    const name = names[index]
    return name && definition.agent ? [[name, definition.agent]] : []
  }))
  consoleInvocations[consoleInvokeEnabledKey] = "invoke" in installation && installation.invoke === true
  return installed
}

export function getConsoleAgents(): readonly string[] {
  // SAFETY: The global journal registry may be absent; when present, installConsoleAgents owns this metadata field.
  return (resolveConsoleInvocations() as ConsoleAgentInvocations | undefined)?.[consoleAgentsKey] ?? []
}

export function getConsoleAgentDefinition(name: string): Record<string, unknown> | undefined {
  const invocations = resolveConsoleInvocations() as ConsoleAgentInvocations | undefined
  if (invocations?.[consoleInvokeEnabledKey] !== true) return undefined
  return invocations[consoleAgentDefinitionsKey]?.get(name)
}

export interface ConsoleAgentInvokerProfile {
  id: string
  label?: string
}

export function consoleAgentInvokerProfiles(agent: Record<string, unknown>): ConsoleAgentInvokerProfile[] {
  const invoker = agent.invoker
  if (!invoker || typeof invoker !== "object" || Array.isArray(invoker)) return []
  const profiles = Reflect.get(invoker, "profiles")
  if (!Array.isArray(profiles)) return []
  return profiles.flatMap((profile) => {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return []
    const id = Reflect.get(profile, "id")
    if (typeof id !== "string" || !id.trim()) return []
    const label = Reflect.get(profile, "label")
    return [{
      id: id.trim(),
      ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
    }]
  })
}
