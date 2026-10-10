import { agentDefinitionSourceSymbol } from "./agent-definition-source.ts"
import { hasRuntimeType } from "./runtime-type.ts"
import type { WorkspaceSourceInput } from "@vite-hub/workspace"

export const colocatedAgentSkillsSymbol: symbol = Symbol.for("vitehub.agent.colocatedSkills")
export const discoveredSkillsSetter: symbol = Symbol.for("vitehub.agent.discoveredSkillsSetter")

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
  if (!agent || !hasRuntimeType(agent, "object")) return agent
  const setDiscoveredSkills: unknown = Reflect.get(agent, discoveredSkillsSetter)
  if (hasRuntimeType(setDiscoveredSkills, "function")) {
    setDiscoveredSkills(skills)
    return agent
  }
  const existing = Object.getOwnPropertyDescriptor(agent, colocatedAgentSkillsSymbol)
  if (skills && existing?.get) {
    const previous = Reflect.get(agent, colocatedAgentSkillsSymbol)
    Object.defineProperty(agent, colocatedAgentSkillsSymbol, {
      configurable: true,
      enumerable: true,
      value: {
        ...(hasRuntimeType(previous, "object") ? previous : {}),
        ...skills,
      },
    })
    return agent
  }
  if (!skills || !Object.keys(skills).length) {
    // Keep inherited Skills getters installed by Agent layers. Only clear a
    // concrete decoration owned by this definition.
    if (Object.getOwnPropertyDescriptor(agent, colocatedAgentSkillsSymbol)?.get) return agent
    // SAFETY: Runtime object narrowing above guarantees a symbol-keyed property target.
    delete (agent as Record<symbol, unknown>)[colocatedAgentSkillsSymbol]
    return agent
  }
  const resolved = Object.create(Object.getPrototypeOf(agent), Object.getOwnPropertyDescriptors(agent))
  const descriptor = { configurable: true, enumerable: true, value: skills }
  // Keep the source decoration on the original definition. Vite discovery
  // returns a decorated clone, while runtime-created layers extend the
  // original definition.
  Object.defineProperty(agent, colocatedAgentSkillsSymbol, descriptor)
  Object.defineProperty(resolved, colocatedAgentSkillsSymbol, descriptor)
  Object.defineProperty(resolved, agentDefinitionSourceSymbol, { configurable: true, value: agent })
  return resolved
}

/**
 * Add Skills to an Agent Definition without changing the original.
 * Each key is a Skill name, and each value is its `SKILL.md` content.
 * The result keeps the Skills of the original definition, including Skills that discovery adds later.
 * A Skill with the same name replaces the original one.
 */
export function agentWithSkills<Agent extends object>(agent: Agent, skills: Record<string, string | Uint8Array>): Agent {
  const added: Record<string, { content: string | Uint8Array, materialize: "startup", mount: "", workspacePath: string }> = {}
  for (const [name, content] of Object.entries(skills)) {
    if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") {
      throw new TypeError(`[vitehub] Invalid Skill name "${name}". Use letters, digits, ".", "_", or "-".`)
    }
    const workspacePath = `.agents/skills/${name}/SKILL.md`
    added[`__vitehubAgentSkill:${workspacePath}`] = { content, materialize: "startup", mount: "", workspacePath }
  }
  // SAFETY: The copy keeps the prototype and every own property descriptor of the Agent Definition.
  const resolved = Object.create(Object.getPrototypeOf(agent), Object.getOwnPropertyDescriptors(agent)) as Agent
  let discovered: ColocatedAgentSkills | undefined
  // Discovery updates local sources without replacing the manually composed getter.
  Object.defineProperty(resolved, discoveredSkillsSetter, {
    configurable: true,
    value: (sources: ColocatedAgentSkills | undefined) => { discovered = sources },
  })
  Object.defineProperty(resolved, colocatedAgentSkillsSymbol, {
    configurable: true,
    enumerable: true,
    get: () => {
      const inherited: unknown = Reflect.get(agent, colocatedAgentSkillsSymbol)
      return { ...(hasRuntimeType(inherited, "object") ? inherited : undefined), ...discovered, ...added }
    },
  })
  return resolved
}
