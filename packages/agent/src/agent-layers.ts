import { hasRuntimeType } from "./internal/runtime-type.ts"
import { resolveNamedAgentPresetOptions } from "./agent-presets.ts"
import type { AgentDefinition, AgentSettings } from "./types.ts"

interface ConfiguredLayer {
  options: Record<string, unknown>
  configure: (options: Record<string, unknown>) => unknown
  overrides: Record<string, unknown>
}

const configuredLayers = new WeakMap<object, ConfiguredLayer>()
const pendingConfiguredLayers = new WeakMap<object, ConfiguredLayer>()
const layerOptions = new WeakMap<object, Record<string, unknown>>()

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && hasRuntimeType(value, "object")
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

// These maps contain definitions and callbacks, not configuration to merge recursively.
const opaqueOptions = new Set(["messages.meta", "messages.state", "invocations", "runtime", "driver.output", "driver.model"])
const definitionMaps = new Set(["channels", "workspace.sources", "workspace.skills", "hooks"])

function merge(parent: unknown, child: unknown, path: string): unknown {
  if (child === undefined) return parent
  if (path === "driver") {
    if (hasRuntimeType(parent, "string")) parent = { kind: parent }
    if (record(child) && ("run" in child || (record(parent) && "run" in parent && "model" in child))) return child
    if (record(child) && hasRuntimeType(child.model, "object")) return child
  }
  if (path === "workspace" && record(parent) && record(child) && (("name" in parent) !== ("name" in child))) return child
  if (opaqueOptions.has(path)) return child
  if (path === "capabilities") {
    if (!Array.isArray(parent) || !Array.isArray(child)) return child
    const capabilities = new Map<string, unknown>()
    for (const capability of [...parent, ...child]) {
      if (!record(capability) || !hasRuntimeType(capability.id, "string")) {
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
  input = resolveNamedAgentPresetOptions(input)
  if (!record(input)) return input
  if (!("extends" in input)) {
    if ("options" in input) throw new TypeError("[vitehub] Agent options require a preset with options and configure.")
    return input
  }
  const { extends: parent, options: presetOptions, ...overrides } = input
  if (!parent || !hasRuntimeType(parent, "object") || !layerOptions.has(parent)) {
    throw new TypeError("[vitehub] defineAgent({ extends }) requires an Agent Definition created by defineAgent().")
  }
  const configured = configuredLayers.get(parent)
  if (!configured && "options" in input) {
    throw new TypeError("[vitehub] Agent options require a preset with options and configure.")
  }
  if (configured) {
    if (presetOptions !== undefined && !record(presetOptions)) {
      throw new TypeError("[vitehub] Agent preset options must be an object.")
    }
    const options = mergePresetOptions(configured.options, presetOptions)
    const definition = configured.configure(mergePresetOptions({}, options))
    assertLayerDefinition(definition)
    const { name: _inheritedName, ...parentOverrides } = configured.overrides
    const inheritedOverrides = merge(parentOverrides, overrides, "")
    if (!record(inheritedOverrides)) throw new TypeError("[vitehub] Invalid Agent layer overrides.")
    const { name: _parentName, ...defaults } = layerOptions.get(definition)!
    const resolved = merge(defaults, inheritedOverrides, "")
    if (!record(resolved)) throw new TypeError("[vitehub] Invalid Agent layer options.")
    pendingConfiguredLayers.set(resolved, { ...configured, options, overrides: inheritedOverrides })
    return resolved
  }
  const { name: _parentName, ...defaults } = layerOptions.get(parent)!
  return merge(defaults, overrides, "")
}

export function rememberAgentLayerOptions<T extends AgentDefinition>(definition: T, options: AgentSettings, source: AgentSettings = options): T {
  layerOptions.set(definition, { ...options })
  const configured = pendingConfiguredLayers.get(source)
  if (configured) rememberConfiguredLayer(definition, configured)
  return definition
}

function assertLayerDefinition(value: unknown): asserts value is AgentDefinition {
  if (!value || !hasRuntimeType(value, "object") || !layerOptions.has(value)) {
    throw new TypeError("[vitehub] Agent configure must return an Agent Definition created by defineAgent().")
  }
}

// Options contain application data, so driver and capability merge rules do not apply.
function mergePresetOptions(parent: Record<string, unknown>, child?: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(parent), ...Object.keys(child ?? {})])) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue
    const value = child?.[key] === undefined ? parent[key] : child[key]
    result[key] = record(value)
      ? mergePresetOptions(record(parent[key]) ? parent[key] : {}, value)
      : Array.isArray(value) ? [...value] : value
  }
  return result
}

export function createConfiguredAgentDefinition(input: unknown): AgentDefinition | undefined {
  if (!record(input) || !("configure" in input)) return undefined
  if (!record(input.options) || !hasRuntimeType(input.configure, "function")
    || Object.keys(input).some(key => key !== "options" && key !== "configure")) {
    throw new TypeError("[vitehub] A configured Agent requires only options defaults and a configure callback.")
  }
  const configure = input.configure
  const options = mergePresetOptions({}, input.options)
  const definition = configure(mergePresetOptions({}, options))
  assertLayerDefinition(definition)
  rememberConfiguredLayer(definition, { options, configure, overrides: {} })
  return definition
}

function rememberConfiguredLayer(definition: AgentDefinition, configured: ConfiguredLayer): void {
  configuredLayers.set(definition, configured)
  Object.defineProperty(definition, "options", {
    value: Object.freeze(mergePresetOptions({}, configured.options)),
    enumerable: true,
    configurable: true,
  })
}
