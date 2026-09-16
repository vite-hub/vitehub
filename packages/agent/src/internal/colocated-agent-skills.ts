import { hasRuntimeType } from "./runtime-type.ts"
import type { WorkspaceSourceInput } from "@vite-hub/workspace"
import { normalizeWorkspaceSourcesMetadata, workspaceSourceGrantPaths } from "@vite-hub/workspace/source-metadata"

export const colocatedAgentSkillsSymbol: symbol = Symbol.for("vitehub.agent.colocatedSkills")
export const colocatedAgentSkillsContextKey = "agent.colocatedSkills"

export type ColocatedAgentSkills = Record<string, WorkspaceSourceInput>

export function filterColocatedAgentSkills(skills: ColocatedAgentSkills, explicitSources: ColocatedAgentSkills = {}): ColocatedAgentSkills {
  const explicitPaths = normalizeWorkspaceSourcesMetadata(explicitSources).flatMap(source => {
    if (source.requestOnly) return []
    // Sources without static item paths own their mount for fallback purposes.
    const recursive = !source.probeKeys?.length
    const paths = recursive ? [source.mountPath] : workspaceSourceGrantPaths(source.key, explicitSources[source.key]!)
    return paths.map(path => ({ path, recursive }))
  })
  return Object.fromEntries(Object.entries(skills).filter(([key, source]) =>
    !Object.hasOwn(explicitSources, key) && !workspaceSourceGrantPaths(key, source).some(path =>
      explicitPaths.some(explicit => path === explicit.path || explicit.recursive && (!explicit.path || path.startsWith(`${explicit.path}/`))),
    ),
  ))
}

interface EncodedColocatedAgentSkillSource {
  content: string
  encoding: "base64"
}

export function decodeColocatedAgentSkills(
  sources: Record<string, EncodedColocatedAgentSkillSource> | undefined,
): ColocatedAgentSkills | undefined {
  if (!sources) return
  // SAFETY: The internal owner establishes the exact asserted Agent runtime contract.
  return Object.fromEntries(Object.entries(sources).map(([key, source]) => {
    const { content, encoding: _encoding, ...options } = source
    return [key, {
      ...options,
      content: Uint8Array.from(atob(content), byte => byte.charCodeAt(0)),
    }]
  })) as ColocatedAgentSkills
}

export function withColocatedAgentSkills<Agent>(agent: Agent, skills: ColocatedAgentSkills | undefined): Agent {
  if (!skills || !Object.keys(skills).length || !agent || !hasRuntimeType(agent, "object")) return agent
  const resolved = Object.create(Object.getPrototypeOf(agent), Object.getOwnPropertyDescriptors(agent))
  Object.defineProperty(resolved, colocatedAgentSkillsSymbol, { configurable: true, enumerable: true, value: skills })
  return resolved
}
