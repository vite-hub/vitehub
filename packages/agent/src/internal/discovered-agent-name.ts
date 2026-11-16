import { registerPublicUrlAgentName } from "@vite-hub/runtime/internal/public-url"
import { agentDefinitionSourceSymbol } from "./agent-definition-source.ts"

import type { AgentHostIdentity } from "../types.ts"

// Discovery names an Agent Definition from its file when the definition has no explicit name.
export const discoveredAgentName: unique symbol = Symbol.for("vitehub.discoveredAgentName")
// The Workspace that the host gives a discovered Workspace Agent.
export const discoveredAgentWorkspace: unique symbol = Symbol.for("vitehub.discoveredAgentWorkspace")

type DiscoveredAgent = { [discoveredAgentName]?: unknown, [discoveredAgentWorkspace]?: unknown, name?: unknown }

function linkedDefinitions(agent: unknown): object[] {
  const linked: object[] = []
  const seen = new Set<object>()
  let current: unknown = agent
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    linked.push(current)
    // SAFETY: framework-owned metadata is attached only to Agent Definition objects.
    const source: unknown = (current as Record<symbol, unknown>)[agentDefinitionSourceSymbol]
    current = typeof source === "object" && source !== null ? source : undefined
  }
  return linked
}

export function markDiscoveredAgentName(agent: unknown, name: string, workspace?: string): void {
  if (typeof agent !== "object" || agent === null) return
  const linked = linkedDefinitions(agent)
  // A shared Definition cannot identify which discovered alias a direct caller imported.
  const ambiguous = linked.some((definition) => {
    // SAFETY: linkedDefinitions returns objects before reading this framework-owned key.
    const previous = (definition as DiscoveredAgent)[discoveredAgentName]
    return previous === null || (typeof previous === "string" && previous !== name)
  })
  for (const definition of linked) {
    Object.defineProperty(definition, discoveredAgentName, { configurable: true, value: ambiguous ? null : name })
    if (workspace) Object.defineProperty(definition, discoveredAgentWorkspace, { configurable: true, value: workspace })
    // SAFETY: linkedDefinitions returns objects; the explicit name remains untrusted until checked.
    const explicitName = (definition as DiscoveredAgent).name
    if (typeof explicitName === "string" && explicitName) registerPublicUrlAgentName(explicitName, name)
  }
}

export function readDiscoveredAgentName(agent: unknown): string | undefined {
  if (typeof agent !== "object" || agent === null) return
  // SAFETY: linkedDefinitions returns objects before reading this framework-owned key.
  const names = linkedDefinitions(agent).map((definition) => (definition as DiscoveredAgent)[discoveredAgentName])
  if (names.includes(null)) return
  return names.find((name): name is string => typeof name === "string" && name.length > 0)
}

/**
 * Marks the default export of a discovered Agent module when the module loads, so a caller that imports the
 * Definition gets its host identity before the host routes load.
 */
export function withDiscoveredAgentName<Agent>(agent: Agent, name: string, workspace?: string): Agent {
  markDiscoveredAgentName(agent, name, workspace)
  return agent
}

/** The identity that the host gives the routes of a discovered Agent. */
export function readDiscoveredAgentIdentity(agent: unknown): AgentHostIdentity | undefined {
  const name = readDiscoveredAgentName(agent)
  if (!name) return
  // SAFETY: linkedDefinitions returns objects before reading this framework-owned key.
  const workspace = linkedDefinitions(agent).map(definition => (definition as DiscoveredAgent)[discoveredAgentWorkspace])
    .find((value): value is string => typeof value === "string" && value.length > 0)
  return workspace ? { name, workspace } : { name }
}

export { resetPublicUrlAgentNames } from "@vite-hub/runtime/internal/public-url"
