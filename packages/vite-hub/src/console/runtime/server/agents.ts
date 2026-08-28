import { consoleInvocationsFallbackKey, resolveConsoleInvocations } from "../../internal.ts"

import type { AgentInvocations } from "@vite-hub/agent"

export const consoleAgentsKey: unique symbol = Symbol.for("vitehub.console.agents")

export type ConsoleAgentDefinitionEntry = {
  definition: unknown
  fallbackName: string
}

type ConsoleAgentInvocations = AgentInvocations & {
  [consoleAgentsKey]?: readonly string[]
}

const consoleAssignedInvocations = new WeakMap<object, AgentInvocations>()

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
  invocations: AgentInvocations,
): readonly string[] {
  return installConsoleAgents(entries.map(({ definition, fallbackName }) => {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Generated plugins can import arbitrary JavaScript definitions, so inspect their runtime shape at this boundary.
    // SAFETY: The object check establishes the string-keyed record needed to inspect a generated module namespace.
    const module = definition && typeof definition === "object" ? definition as Record<string, unknown> : undefined
    let agent = module
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Generated plugins can provide an arbitrary default export, so inspect its runtime shape at this boundary.
    if (module?.default && typeof module.default === "object") {
      // SAFETY: The object check establishes the string-keyed record needed to inspect a generated module default export.
      agent = module.default as Record<string, unknown>
    }
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
  }), invocations)
}

export function getConsoleAgents(): readonly string[] {
  // SAFETY: The global journal registry may be absent; when present, installConsoleAgents owns this metadata field.
  return (resolveConsoleInvocations() as ConsoleAgentInvocations | undefined)?.[consoleAgentsKey] ?? []
}
