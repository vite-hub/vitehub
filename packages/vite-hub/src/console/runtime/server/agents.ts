import { consoleInvocationsFallbackKey, resolveConsoleInvocations } from "../../internal.ts"
import { installConsoleInvocations } from "./invocations.ts"
import * as v from "valibot"

import type { AgentInput, AgentInvocations } from "@vite-hub/agent"
import type { AgentInvocationsOptions } from "@vite-hub/agent/server"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

export const consoleAgentsKey: unique symbol = Symbol.for("vitehub.console.agents")
export const consoleAgentDefinitionsKey: unique symbol = Symbol.for("vitehub.console.agent-definitions")
export const consoleInvokeEnabledKey: unique symbol = Symbol.for("vitehub.console.invoke-enabled")

export type ConsoleAgentDefinitionEntry = {
  definition: unknown
  fallbackName: string
}

export type ConsoleAgentDefinitionInstallation =
  | { invocations: AgentInvocations, projectRoot?: never }
  | { invocations?: never, invoke?: boolean, observations?: AgentInvocationsOptions["observations"], projectRoot: string }

type ConsoleAgentInvocations = AgentInvocations & {
  [consoleAgentDefinitionsKey]?: ReadonlyMap<string, AgentInput>
  [consoleAgentsKey]?: readonly string[]
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
  const result = v.safeParse(recordSchema, value)
  return result.success ? result.output : undefined
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
    throw viteHubErrorDiagnostics.VITE_HUB_R0047({ message: "[vitehub] Console cannot inspect multiple Agent invocation journals. Configure one shared journal for the discovered Agent Definitions." })
  }
  return installConsoleInvocations(installation.projectRoot, configured[0], installation.observations)
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
    return agent?.name?.trim() ? agent.name : fallbackName
  })
  const installed = installConsoleAgents(names, invocations)
  // SAFETY: This intersection only attaches console-owned metadata to the Agent invocation journal.
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
