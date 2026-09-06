import { hasRuntimeType } from "./runtime-type.ts"
import type { WorkspaceSourceInput } from "@vite-hub/workspace"

export const colocatedAgentSkillsSymbol: symbol = Symbol.for("vitehub.agent.colocatedSkills")
export const colocatedAgentSkillsContextKey = "agent.colocatedSkills"

export type ColocatedAgentSkills = Record<string, WorkspaceSourceInput>

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
