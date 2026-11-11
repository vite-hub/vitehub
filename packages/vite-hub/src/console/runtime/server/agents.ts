import { markConsoleSuppliedInvocations, resolveConsoleInvocations, resolveConsoleSuppliedInvocations } from "../../internal.ts"
import { agentInvocationsDisabledKey, agentInvocationsFallbackKey, installAgentInvocationsOverride, resolveDefaultAgentInvocations } from "@vite-hub/agent/invocations/app"
import { installConsoleInvocations } from "./invocations.ts"
import * as v from "valibot"
import { markDiscoveredAgentName } from "@vite-hub/agent/server/internal"

import type { AgentInput, AgentInvocations } from "@vite-hub/agent"
import type { RuntimeCapabilities } from "@vite-hub/runtime"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

export const consoleAgentsKey: unique symbol = Symbol.for("vitehub.console.agents")
export const consoleAgentDefinitionsKey: unique symbol = Symbol.for("vitehub.console.agent-definitions")
export const consoleInvokeEnabledKey: unique symbol = Symbol.for("vitehub.console.invoke-enabled")
export const consoleAgentCapabilitiesKey: unique symbol = Symbol.for("vitehub.console.agent-capabilities")

export type ConsoleAgentDefinitionEntry = {
  definition: unknown
  fallbackName: string
}

/** The Agent capabilities of a Console invocation, or a loader that imports them on the first invocation. */
export type ConsoleAgentCapabilities = RuntimeCapabilities | (() => Promise<RuntimeCapabilities>)

export type ConsoleAgentDefinitionInstallation =
  | { capabilities?: ConsoleAgentCapabilities, invocations: AgentInvocations, projectRoot?: never }
  | { capabilities?: ConsoleAgentCapabilities, invocations?: never, invoke?: boolean, projectRoot: string }

type ConsoleAgentInvocations = AgentInvocations & {
  [consoleAgentDefinitionsKey]?: ReadonlyMap<string, AgentInput>
  [consoleAgentsKey]?: readonly string[]
  [consoleAgentCapabilitiesKey]?: ConsoleAgentCapabilities
  [consoleInvokeEnabledKey]?: boolean
}

const consoleAssignedInvocations = new WeakMap<object, AgentInvocations>()
const functionSchema = v.function()
const recordSchema = v.record(v.string(), v.unknown())
const stringSchema = v.string()

type ResolvedConsoleAgentDefinition = {
  agent?: AgentInput
  fallbackName: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return
  // Keep definition identity and symbol metadata for journal ownership and rebinding.
  return v.is(recordSchema, value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  const result = v.safeParse(stringSchema, value)
  return result.success ? result.output : undefined
}

const agentDefinitionSchema = v.custom<AgentInput>((value) => {
  const input = record(value)
  return Boolean(input && v.safeParse(functionSchema, input.resolve).success)
})

function resolveConsoleAgentDefinition(
  entry: ConsoleAgentDefinitionEntry,
): ResolvedConsoleAgentDefinition {
  const { definition, fallbackName } = entry
  const module = record(definition)
  const defaultAgent = record(module?.default)
  const result = v.safeParse(agentDefinitionSchema, defaultAgent ?? module)
  const agent = result.success ? result.output : undefined
  return { agent, fallbackName }
}

function explicitAgentInvocations(agent: AgentInput | undefined): AgentInvocations | undefined {
  if (!agent || Reflect.get(agent, agentInvocationsFallbackKey) === true) return undefined
  const assigned = consoleAssignedInvocations.get(agent)
  const invocations = agent.invocations
  if (invocations === undefined || invocations === assigned) return undefined
  // SAFETY: Agent Definitions own this field; Console passes the discovered value only to the Agent invocation journal boundary that defined it.
  return invocations as AgentInvocations
}

/** The app-wide `agent.invocations` journal of an Agent Definition that does not set its own journal. */
function defaultAgentInvocations(agent: AgentInput | undefined): AgentInvocations | undefined {
  if (!agent || Reflect.get(agent, agentInvocationsFallbackKey) !== true || Reflect.get(agent, agentInvocationsDisabledKey) === true) return undefined
  return resolveDefaultAgentInvocations()
}

function resolveConsoleAgentInvocations(
  definitions: readonly ResolvedConsoleAgentDefinition[],
  installation: ConsoleAgentDefinitionInstallation,
): AgentInvocations {
  if (installation.invocations) {
    // A journal that the Console supplies replaces the app-wide journal of discovered Agents.
    markConsoleSuppliedInvocations(installation.invocations)
    installAgentInvocationsOverride(resolveConsoleSuppliedInvocations)
    return installation.invocations
  }
  const configured = [...new Set(definitions.flatMap(({ agent }) => {
    const journal = explicitAgentInvocations(agent) ?? defaultAgentInvocations(agent)
    return journal ? [journal] : []
  }))]
  if (configured.length > 1) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0047({ message: "[vitehub] Console cannot inspect multiple Agent invocation journals. Configure one shared journal for the discovered Agent Definitions." })
  }
  // Without an Agent journal, the Console reads the app-wide journal that ViteHub installs with the Console on or off.
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
    if (agent && Reflect.get(agent, agentInvocationsFallbackKey) !== true) {
      const assigned = consoleAssignedInvocations.get(agent)
      if (agent.invocations === undefined || agent.invocations === assigned) {
        agent.invocations = invocations
        consoleAssignedInvocations.set(agent, invocations)
      }
      else if (assigned) {
        consoleAssignedInvocations.delete(agent)
      }
    }
    if (agent?.name?.trim()) return agent.name
    // Invocations started outside a host route record the name that the Console lists.
    if (agent) markDiscoveredAgentName(agent, fallbackName)
    return fallbackName
  })
  const installed = installConsoleAgents(names, invocations)
  // SAFETY: This intersection only attaches console-owned metadata to the Agent invocation journal.
  const consoleInvocations = invocations as ConsoleAgentInvocations
  if (installation.capabilities) consoleInvocations[consoleAgentCapabilitiesKey] = installation.capabilities
  else delete consoleInvocations[consoleAgentCapabilitiesKey]
  consoleInvocations[consoleAgentDefinitionsKey] = new Map(definitions.flatMap((definition, index) => {
    const name = names[index]
    return name && definition.agent ? [[name, definition.agent]] : []
  }))
  consoleInvocations[consoleInvokeEnabledKey] = "invoke" in installation && installation.invoke === true
  return installed
}

export async function getConsoleAgentCapabilities(): Promise<RuntimeCapabilities> {
  const invocations = resolveConsoleInvocations() as ConsoleAgentInvocations | undefined
  const capabilities = invocations?.[consoleAgentCapabilitiesKey]
  return typeof capabilities === "function" ? await capabilities() : capabilities ?? {}
}

export function getConsoleAgents(): readonly string[] {
  // SAFETY: The global journal registry may be absent; when present, installConsoleAgents owns this metadata field.
  return (resolveConsoleInvocations() as ConsoleAgentInvocations | undefined)?.[consoleAgentsKey] ?? []
}

export function getConsoleAgentDefinition(name: string, access: "invoke" | "inspect" = "invoke"): AgentInput | undefined {
  // SAFETY: The global journal registry may be absent; installConsoleAgentDefinitions owns these metadata fields.
  const invocations = resolveConsoleInvocations() as ConsoleAgentInvocations | undefined
  if (access === "invoke" && invocations?.[consoleInvokeEnabledKey] !== true) return undefined
  return invocations?.[consoleAgentDefinitionsKey]?.get(name)
}

export interface ConsoleAgentInvokerProfile {
  id: string
  label?: string
}

export function consoleAgentInvokerProfiles(agent: AgentInput): ConsoleAgentInvokerProfile[] {
  const invoker = record(agent.invoker)
  if (!invoker) return []
  const profiles = invoker.profiles
  if (!Array.isArray(profiles)) return []
  return profiles.flatMap((profile) => {
    const input = record(profile)
    const id = stringValue(input?.id)?.trim()
    if (!id) return []
    const label = stringValue(input?.label)?.trim()
    const resolved: ConsoleAgentInvokerProfile = { id }
    if (label) resolved.label = label
    return [resolved]
  })
}
