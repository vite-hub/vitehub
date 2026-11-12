import { agentDefinitionSourceSymbol } from "./agent-definition-source.ts"
import { isRuntimeRecord } from "./runtime-type.ts"
import type { WorkspaceSourceInput } from "@vite-hub/workspace"

export const colocatedAgentSkillsSymbol: symbol = Symbol.for("vitehub.agent.colocatedSkills")
export const discoveredSkillsUpdate: symbol = Symbol.for("vitehub.agent.discoveredSkillsUpdate")
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

function skillName(source: unknown): string | undefined {
  return isRuntimeRecord(source) && typeof source.workspacePath === "string" ? source.workspacePath.split("/")[2] : undefined
}

/**
 * Skills extend by name. A Skill folder of the Agent replaces the inherited folder with the same name, including its references.
 * The generated Agent registry in `vite.ts` keeps a copy of this rule.
 */
function extendColocatedAgentSkills(inherited: unknown, skills: ColocatedAgentSkills): ColocatedAgentSkills {
  const ownSkillNames = new Set(Object.values(skills).map(skillName))
  const kept = isRuntimeRecord(inherited) ? Object.entries(inherited).filter(([, source]) => !ownSkillNames.has(skillName(source))) : []
  // SAFETY: Inherited entries come from the colocated Skills of the parent Agent.
  return { ...Object.fromEntries(kept) as ColocatedAgentSkills, ...skills }
}

export function withColocatedAgentSkills<Agent>(agent: Agent, skills: ColocatedAgentSkills | undefined): Agent {
  if (!agent || typeof agent !== "object") return agent
  const setDiscoveredSkills: unknown = Reflect.get(agent, discoveredSkillsSetter)
  if (typeof setDiscoveredSkills === "function") {
    setDiscoveredSkills(skills)
    return agent
  }
  const inheritedSkills = Object.getOwnPropertyDescriptor(agent, colocatedAgentSkillsSymbol)?.get
  const update: unknown = inheritedSkills && Reflect.get(inheritedSkills, discoveredSkillsUpdate)
  if (typeof update === "function") {
    update(skills)
    return agent
  }
  if (skills && Object.keys(skills).length && inheritedSkills) {
    // Read the inherited Skills when the Agent runs, so the result follows later changes to the parent.
    let local = skills
    const get = () => extendColocatedAgentSkills(inheritedSkills.call(agent), local)
    // Keep the inherited accessor once; later discovery replaces only the local set.
    Object.defineProperty(get, discoveredSkillsUpdate, {
      value: (sources: ColocatedAgentSkills | undefined) => { local = sources ?? {} },
    })
    Object.defineProperty(agent, colocatedAgentSkillsSymbol, {
      configurable: true,
      enumerable: true,
      get,
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
      return { ...(typeof inherited === "object" ? inherited : undefined), ...discovered, ...added }
    },
  })
  return resolved
}

// The UTF-8 size of text without encoding it. A lone surrogate encodes as U+FFFD, which takes three bytes.
function utf8ByteLength(text: string): number {
  let length = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return length
}

/**
 * List the bundled files that discovery and Agent layers will materialize at startup.
 * `read()` returns a copy of one file, so a caller can check `size` before it copies the content.
 */
export function inspectAgentSkillFiles(agent: object): { path: string, size: number, read: () => Uint8Array }[] {
  const sources: unknown = Reflect.get(agent, colocatedAgentSkillsSymbol)
  if (!isRuntimeRecord(sources)) return []
  return Object.values(sources).flatMap((source: unknown) => {
    if (!isRuntimeRecord(source) || typeof source.workspacePath !== "string") return []
    const path = source.workspacePath
    const content = source.content
    if (typeof content === "string") return [{ path, size: utf8ByteLength(content), read: () => new TextEncoder().encode(content) }]
    return content instanceof Uint8Array ? [{ path, size: content.byteLength, read: () => content.slice() }] : []
  }).sort((left, right) => left.path.localeCompare(right.path))
}
