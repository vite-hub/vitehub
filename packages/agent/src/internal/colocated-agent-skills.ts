import { hasRuntimeType } from "./runtime-type.ts"
import type { WorkspaceSourceInput } from "@vite-hub/workspace"
import { normalizeWorkspaceSourcesMetadata, workspaceSourceGrantPaths } from "@vite-hub/workspace/source-metadata"

export const colocatedAgentSkillsSymbol: symbol = Symbol.for("vitehub.agent.colocatedSkills")
export const colocatedAgentSkillsContextKey = "agent.colocatedSkills"

export type ColocatedAgentSkills = Record<string, WorkspaceSourceInput>

export function filterColocatedAgentSkills(skills: ColocatedAgentSkills, explicitSources: ColocatedAgentSkills = {}): ColocatedAgentSkills {
  const explicitPaths = normalizeWorkspaceSourcesMetadata(explicitSources).flatMap(source => {
    if (source.requestOnly || source.probeKeys?.length === 0) return []
    // Sources without static item paths own their mount for fallback purposes.
    const recursive = !source.probeKeys?.length
    const paths = recursive ? [source.mountPath] : workspaceSourceGrantPaths(source.key, explicitSources[source.key]!)
    return paths.map(path => ({ path, recursive }))
  })
  const blockedSkillRoots = new Set<string>()
  const entries = Object.entries(skills).map(([key, source]) => {
    const paths = workspaceSourceGrantPaths(key, source)
    const roots = paths.flatMap(path => path.match(/^\.agents\/skills\/[^/]+(?=\/|$)/)?.[0] || [])
    const blocked = Object.hasOwn(explicitSources, key) || paths.some(path =>
      explicitPaths.some(explicit => path === explicit.path || path.startsWith(`${explicit.path}/`) || explicit.path.startsWith(`${path}/`) || explicit.recursive && !explicit.path),
    )
    if (blocked) for (const root of roots) blockedSkillRoots.add(root)
    return { key, source, roots, blocked }
  })
  const filtered = entries.filter(entry => !entry.blocked && !entry.roots.some(root => blockedSkillRoots.has(root)))
  if (filtered.length === entries.length) return skills
  return Object.fromEntries(filtered.map(({ key, source }) => [key, source]))
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
