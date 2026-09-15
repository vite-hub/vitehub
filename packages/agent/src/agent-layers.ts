import { hasRuntimeType } from "./internal/runtime-type.ts"
import { resolveNamedAgentPresetOptions } from "./agent-presets.ts"
import type { AgentDefinition, AgentSettings } from "./types.ts"

interface ConfiguredLayer {
  options: Record<string, unknown>
  configure: (options: Record<string, unknown>) => unknown
  overrides: Record<string, unknown>
}

interface AgentLayerMetadata {
  options: AgentSettings
  configured?: ConfiguredLayer
  defaults?: Partial<AgentSettings>
  parent?: object
}

export const agentLayerMetadata: unique symbol = Symbol("vitehub.agent.layer")
const colocatedSkills = Symbol.for("vitehub.agent.colocatedSkills")

function layerMetadata(value: unknown): AgentLayerMetadata | undefined {
  if (!value || !hasRuntimeType(value, "object")) return
  // SAFETY: This private symbol is attached only by this module.
  return (value as { [agentLayerMetadata]?: AgentLayerMetadata })[agentLayerMetadata]
}

function rememberLayerMetadata(value: Record<string, unknown>, metadata: AgentLayerMetadata): void {
  Object.defineProperty(value, agentLayerMetadata, { configurable: true, value: metadata })
}

function inheritColocatedSkills(parent: Record<string, unknown>, child: Record<string, unknown>): void {
  const skills = Object.getOwnPropertyDescriptor(parent, colocatedSkills)
  if (skills) Object.defineProperty(child, colocatedSkills, skills)
}


function record(value: unknown): value is Record<string, unknown> {
  return value !== null && hasRuntimeType(value, "object")
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

// These maps contain definitions and callbacks, not configuration to merge recursively.
const opaqueOptions = new Set(["messages.meta", "messages.state", "invocations", "runtime", "driver.output", "driver.model"])
const definitionMaps = new Set(["channels", "workspace.sources", "workspace.skills", "hooks"])

function merge(parent: unknown, child: unknown, path: string): unknown {
  if (child === undefined) return parent
  if (path === "driver.instructions") {
    if (record(child)) return child
    if (record(parent) && "template" in parent) return { ...parent, content: child }
    return child
  }
  if (path === "driver") {
    if (hasRuntimeType(parent, "string")) parent = { kind: parent }
    if (hasRuntimeType(child, "string")) child = { kind: child }
    if (record(child) && record(parent) && !("kind" in parent) && !("kind" in child)
      && "model" in parent && hasRuntimeType(child.model, "object") && !("run" in child)) {
      return {
        ...parent,
        ...child,
        instructions: merge(parent.instructions, child.instructions, "driver.instructions"),
      }
    }
    if (record(child) && ("run" in child || (record(parent) && "run" in parent && "model" in child))) {
      if (record(parent) && ("run" in parent || "model" in parent) && "model" in child && "instructions" in parent && "instructions" in child) {
        return {
          ...parent,
          ...child,
          instructions: merge(parent.instructions, child.instructions, "driver.instructions"),
        }
      }
      return child
    }
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
  if (path === "driver" && child.kind !== undefined && child.kind !== parent.kind) {
    return {
      ...child,
      instructions: merge(parent.instructions, child.instructions, "driver.instructions"),
    }
  }
  // A different store provider or runtime is a complete replacement.
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
  if (!parent || !hasRuntimeType(parent, "object") || !layerMetadata(parent)) {
    throw new TypeError("[vitehub] defineAgent({ extends }) requires an Agent Definition created by defineAgent().")
  }
  const inherited = layerMetadata(parent)!
  const configured = inherited.configured
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
    const { name: _parentName, ...defaults } = layerMetadata(definition)!.options
    const resolved = merge(merge(inherited.defaults, defaults, ""), inheritedOverrides, "")
    if (!record(resolved)) throw new TypeError("[vitehub] Invalid Agent layer options.")
    // SAFETY: Resolved settings merge a registered definition with its overrides.
    rememberLayerMetadata(resolved, { options: resolved as AgentSettings, configured: { ...configured, options, overrides: inheritedOverrides }, defaults: inherited.defaults, parent })
    return resolved
  }
  const { name: _parentName, ...defaults } = layerMetadata(parent)!.options
  const resolved = merge(defaults, overrides, "")
  if (!record(resolved)) throw new TypeError("[vitehub] Invalid Agent layer options.")
  // SAFETY: Resolved settings merge a registered definition with its overrides.
  rememberLayerMetadata(resolved, { options: resolved as AgentSettings, defaults: inherited.defaults, parent })
  return resolved
}

export function rememberAgentLayerOptions<T extends AgentDefinition>(definition: T, options: AgentSettings, source: AgentSettings = options): T {
  const inherited = layerMetadata(source)
  // SAFETY: Agent definitions are mutable metadata carriers owned by this package.
  const metadataTarget = asMetadataTarget(definition)
  rememberLayerMetadata(metadataTarget, { options: { ...options }, configured: inherited?.configured, defaults: inherited?.defaults })
  if (inherited?.parent) inheritColocatedSkills(asMetadataTarget(inherited.parent), asMetadataTarget(definition))
  // SAFETY: Metadata stores the private configured layer shape created by this module.
  if (inherited?.configured) rememberConfiguredLayer(definition, inherited.configured as ConfiguredLayer)
  return definition
}

function assertLayerDefinition(value: unknown): asserts value is AgentDefinition {
  if (!value || !hasRuntimeType(value, "object") || !layerMetadata(value)) {
    throw new TypeError("[vitehub] Agent configure must return an Agent Definition created by defineAgent().")
  }
}

// Options contain application data, so driver and capability merge rules do not apply.
function mergePresetOptions(parent: Record<string, unknown>, child?: Record<string, unknown>): Record<string, unknown> {
  const memo = new WeakMap<object, unknown>()
  return mergePresetOptionsWithMemo(parent, child, memo)
}

function mergePresetOptionsWithMemo(parent: Record<string, unknown>, child: Record<string, unknown> | undefined, memo: WeakMap<object, unknown>): Record<string, unknown> {
  if (child && memo.has(child)) return memo.get(child) as Record<string, unknown>
  const result: Record<string | symbol, unknown> = {}
  if (child) memo.set(child, result)
  const parentKeys = parent as Record<PropertyKey, unknown>
  const childKeys = child as Record<PropertyKey, unknown> | undefined
  for (const key of new Set([...Reflect.ownKeys(parent), ...Reflect.ownKeys(child ?? {})])) {
    const value = childKeys && Object.prototype.hasOwnProperty.call(childKeys, key) && childKeys[key] !== undefined ? childKeys[key] : parentKeys[key]
    if (record(value)) {
      const parentValue = record(parentKeys[key]) ? parentKeys[key] : {}
      const merged = mergePresetOptionsWithMemo(parentValue, value, memo)
      Object.defineProperty(result, key, { value: merged, enumerable: true, writable: true, configurable: true })
    } else Object.defineProperty(result, key, { value: clonePresetOption(value, memo), enumerable: true, writable: true, configurable: true })
  }
  return result
}

function clonePresetOption(value: unknown, memo = new WeakMap<object, unknown>()): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value
  // Functions are atomic option values; preserve callback identity rather than
  // rejecting them as unsupported objects.
  if (typeof value === "function") return value
  if (memo.has(value)) return memo.get(value)
  if (Array.isArray(value)) { const clone: unknown[] = []; memo.set(value, clone); for (const entry of value) clone.push(clonePresetOption(entry, memo)); return clone }
  if (value instanceof Date) { const clone = new Date(value.getTime()); memo.set(value, clone); return clone }
  if (value instanceof Map) { const clone = new Map(); memo.set(value, clone); for (const [key, entry] of value) clone.set(clonePresetOption(key, memo), clonePresetOption(entry, memo)); return clone }
  if (value instanceof Set) { const clone = new Set(); memo.set(value, clone); for (const entry of value) clone.add(clonePresetOption(entry, memo)); return clone }
  if (value instanceof RegExp) { const clone = new RegExp(value.source, value.flags); memo.set(value, clone); return clone }
  if (value instanceof URL) { const clone = new URL(value.href); memo.set(value, clone); return clone }
  if (value instanceof URLSearchParams) { const clone = new URLSearchParams(value.toString()); memo.set(value, clone); return clone }
  if (value instanceof ArrayBuffer) { const clone = value.slice(0); memo.set(value, clone); return clone }
  if (ArrayBuffer.isView(value)) {
    // SAFETY: Node exposes Buffer as a constructor with the documented isBuffer/from API.
    if ("Buffer" in globalThis && (globalThis as { Buffer: typeof Buffer }).Buffer.isBuffer(value)) return (globalThis as { Buffer: typeof Buffer }).Buffer.from(value)
    if (value instanceof DataView) {
      // SAFETY: DataView intrinsic accessors avoid shadowable instance properties.
      const buffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")!.get!.call(value) as ArrayBuffer
      const byteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset")!.get!.call(value)
      const byteLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get!.call(value)
      return new DataView(buffer.slice(byteOffset, byteOffset + byteLength))
    }
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
    // SAFETY: %TypedArray% intrinsic accessors work for every typed-array view.
    const buffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!.call(value) as ArrayBuffer
    const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!.call(value)
    const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!.call(value)
    const copy = buffer.slice(byteOffset, byteOffset + byteLength)
    // SAFETY: Every entry is a built-in typed-array constructor; filtering removes unavailable BigInt variants.
    const constructors = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, "BigInt64Array" in globalThis ? BigInt64Array : undefined, "BigUint64Array" in globalThis ? BigUint64Array : undefined].filter(Boolean) as any[]
    const TypedArray = constructors.find((ctor) => value instanceof ctor)
    if (!TypedArray) throw new TypeError("[vitehub] Agent preset options must contain cloneable built-in values.")
    return new TypedArray(copy)
  }
  if (value !== null && Object.prototype.toString.call(value) === "[object Object]") {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("[vitehub] Agent preset options must contain cloneable built-in values.")
    }
    // SAFETY: Object values are cloned with their prototype and own descriptors.
    // SAFETY: The prototype is restricted to plain objects or null above.
    const clone = Object.create(prototype) as Record<string, unknown>
    memo.set(value, clone)
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) continue
      if ("value" in descriptor) descriptor.value = clonePresetOption(descriptor.value as unknown, memo)
      Object.defineProperty(clone, key, descriptor)
    }
    return clone
  }
  throw new TypeError("[vitehub] Agent preset options must contain cloneable built-in values.")
}

export function createConfiguredAgentDefinition(input: unknown, create: (options: AgentSettings) => AgentDefinition): AgentDefinition | undefined {
  if (!record(input) || !("configure" in input)) return undefined
  if (!record(input.options) || !hasRuntimeType(input.configure, "function")
    || Object.keys(input).some(key => key !== "options" && key !== "configure")) {
    throw new TypeError("[vitehub] A configured Agent requires only options defaults and a configure callback.")
  }
  const callback = input.configure
  const configure = (options: Record<string, unknown>): unknown => callback(options)
  const options = mergePresetOptions({}, input.options)
  const definition = configure(mergePresetOptions({}, options))
  assertLayerDefinition(definition)
  // A callback may return a shared definition. Keep its configuration and runtime private.
  const configured = create(layerMetadata(definition)!.options)
  const frameworkSymbols = new Set<PropertyKey>([
    Symbol.for("vitehub.baseAgentResolve"),
    Symbol.for("vitehub.baseAgentDefinitionResolve"),
  ])
  for (const key of Reflect.ownKeys(definition)) {
    if (key === "options" || key === "__vitehubAgentSettings" || key === agentLayerMetadata || key === "resolve" || key === "run" || key === "health" || key === "status" || frameworkSymbols.has(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(definition, key)
    if (descriptor) Object.defineProperty(configured, key, descriptor)
  }
  inheritColocatedSkills(asMetadataTarget(definition), asMetadataTarget(configured))
  inheritAgentLayerOptions(asMetadataTarget(definition), asMetadataTarget(configured))
  rememberConfiguredLayer(configured, { options, configure, overrides: {} })
  return configured
}

function asMetadataTarget(value: unknown): Record<string, unknown> {
  // SAFETY: Agent definitions are mutable metadata carriers owned by this package.
  return value as Record<string, unknown>
}

function rememberConfiguredLayer(definition: AgentDefinition, configured: ConfiguredLayer): void {
  // SAFETY: Agent definitions are mutable metadata carriers owned by this package.
  const metadataTarget = asMetadataTarget(definition)
  rememberLayerMetadata(metadataTarget, { ...layerMetadata(definition)!, configured })
  Object.defineProperty(definition, "options", {
    value: Object.freeze(mergePresetOptions({}, configured.options)),
    enumerable: true,
    configurable: true,
  })
}

/** Read resolved settings for package-owned workflows without depending on runtime markers. */
export function getAgentLayerOptions(definition: AgentDefinition): AgentSettings | undefined {
  const options = layerMetadata(definition)?.options
  return options ? { ...options } : undefined
}

/** Keep discovery defaults available without pinning configured values on future extensions. */
export function inheritAgentLayerOptions(parent: unknown, child: unknown, defaults?: Partial<AgentSettings>): void {
  const metadata = layerMetadata(parent)
  if (!metadata || !child || !hasRuntimeType(child, "object")) return
  // SAFETY: Discovery supplies typed defaults for settings of a registered definition.
  rememberLayerMetadata(child as Record<string, unknown>, {
    // SAFETY: merge preserves the AgentSettings shape from typed metadata and defaults.
    options: merge(defaults, metadata.options, "") as AgentSettings,
    configured: metadata.configured,
    // SAFETY: merge preserves the optional partial settings shape.
    defaults: merge(metadata.defaults, defaults, "") as Partial<AgentSettings> | undefined,
  })
}
