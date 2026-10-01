import { hasRuntimeType } from "./runtime-type.ts"
import { agentDefinitionSourceSymbol } from "./agent-definition-source.ts"

// Discovery names an Agent Definition from its file when the definition has no explicit name.
export const discoveredAgentName: unique symbol = Symbol.for("vitehub.discoveredAgentName")

type DiscoveredAgent = { [discoveredAgentName]?: unknown }

function linkedDefinitions(agent: unknown): object[] {
  const linked: object[] = []
  const seen = new Set<object>()
  let current: unknown = agent
  while (hasRuntimeType(current, "object") && current !== null && !seen.has(current)) {
    seen.add(current)
    linked.push(current)
    // SAFETY: framework-owned metadata is attached only to Agent Definition objects.
    const source: unknown = (current as Record<symbol, unknown>)[agentDefinitionSourceSymbol]
    current = hasRuntimeType(source, "object") && source !== null ? source : undefined
  }
  return linked
}

export function markDiscoveredAgentName(agent: unknown, name: string): void {
  if (!hasRuntimeType(agent, "object") || agent === null) return
  const linked = linkedDefinitions(agent)
  // A shared Definition cannot identify which discovered alias a direct caller imported.
  const ambiguous = linked.some((definition) => {
    // SAFETY: linkedDefinitions returns objects before reading this framework-owned key.
    const previous = (definition as DiscoveredAgent)[discoveredAgentName]
    return previous === null || (hasRuntimeType(previous, "string") && previous !== name)
  })
  for (const definition of linked) {
    Object.defineProperty(definition, discoveredAgentName, { configurable: true, value: ambiguous ? null : name })
  }
}

export function readDiscoveredAgentName(agent: unknown): string | undefined {
  if (!hasRuntimeType(agent, "object") || agent === null) return
  // SAFETY: linkedDefinitions returns objects before reading this framework-owned key.
  const names = linkedDefinitions(agent).map((definition) => (definition as DiscoveredAgent)[discoveredAgentName])
  if (names.includes(null)) return
  return names.find((name): name is string => hasRuntimeType(name, "string") && name.length > 0)
}
