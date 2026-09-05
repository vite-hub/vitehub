import type { AgentDefinition, AgentSettings } from "./types.ts"

const layerOptions = new WeakMap<object, Record<string, unknown>>()

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

// These maps contain definitions and callbacks, not configuration to merge recursively.
const opaqueOptions = new Set(["messages.meta", "messages.state", "invocations", "runtime", "driver.output", "driver.model"])
const definitionMaps = new Set(["channels", "workspace.sources", "workspace.skills", "hooks"])

function merge(parent: unknown, child: unknown, path: string): unknown {
  if (child === undefined) return parent
  if (path === "driver") {
    if (typeof parent === "string") parent = { kind: parent }
    if (record(child) && ("run" in child || (record(parent) && "run" in parent && "model" in child))) return child
    if (record(child) && typeof child.model === "object") return child
  }
  if (path === "workspace" && record(parent) && record(child) && (("name" in parent) !== ("name" in child))) return child
  if (opaqueOptions.has(path)) return child
  if (path === "capabilities") {
    if (!Array.isArray(parent) || !Array.isArray(child)) return child
    const capabilities = new Map<string, unknown>()
    for (const capability of [...parent, ...child]) {
      if (!record(capability) || typeof capability.id !== "string") {
        throw new TypeError("[vitehub] Agent layers require explicit capability definitions with stable IDs.")
      }
      capabilities.set(capability.id, capability)
    }
    return [...capabilities.values()]
  }
  if (!record(parent) || !record(child)) return child
  if (definitionMaps.has(path)) return { ...parent, ...child }
  // A different driver, store provider or runtime is a complete replacement.
  for (const discriminator of ["kind", "provider"]) {
    if (child[discriminator] !== undefined && child[discriminator] !== parent[discriminator]) return { ...child }
  }
  const merged = { ...parent }
  for (const [key, value] of Object.entries(child)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue
    merged[key] = merge(parent[key], value, path ? `${path}.${key}` : key)
  }
  return merged
}

/** Rebuild a definition from configuration. Never copy a parent's bound runtime or invocation state. */
export function resolveAgentLayerOptions(input: unknown): unknown {
  if (!record(input) || !("extends" in input)) return input
  const { extends: parent, ...overrides } = input
  if (!parent || typeof parent !== "object" || !layerOptions.has(parent)) {
    throw new TypeError("[vitehub] defineAgent({ extends }) requires an Agent Definition created by defineAgent().")
  }
  const { name: _parentName, ...defaults } = layerOptions.get(parent)!
  return merge(defaults, overrides, "")
}

export function rememberAgentLayerOptions<T extends AgentDefinition>(definition: T, options: AgentSettings): T {
  layerOptions.set(definition, { ...options })
  return definition
}
