import { resolveConsoleInvocations } from "../../internal.ts"

import type { AgentInvocations } from "@vite-hub/agent"

export const consoleAgentsKey: unique symbol = Symbol.for("vitehub.console.agents")

export type ConsoleAgentDefinitionEntry = {
  definition: unknown
  fallbackName: string
}

type ConsoleAgentInvocations = AgentInvocations & {
  [consoleAgentsKey]?: readonly string[]
}

export function installConsoleAgents(
  agentNames: readonly string[],
  invocations: AgentInvocations,
): readonly string[] {
  const agents = [...new Set(agentNames.map(name => name.trim()).filter(Boolean))].sort()
  const consoleInvocations = invocations as ConsoleAgentInvocations
  consoleInvocations[consoleAgentsKey] = agents
  return agents
}

export function installConsoleAgentDefinitions(
  entries: readonly ConsoleAgentDefinitionEntry[],
  invocations: AgentInvocations,
): readonly string[] {
  return installConsoleAgents(entries.map(({ definition, fallbackName }) => {
    const module = definition && typeof definition === "object" ? definition as Record<string, unknown> : undefined
    const agent = module?.default && typeof module.default === "object"
      ? module.default as Record<string, unknown>
      : module
    return typeof agent?.name === "string" && agent.name.trim() ? agent.name : fallbackName
  }), invocations)
}

export function getConsoleAgents(): readonly string[] {
  return (resolveConsoleInvocations() as ConsoleAgentInvocations | undefined)?.[consoleAgentsKey] ?? []
}
