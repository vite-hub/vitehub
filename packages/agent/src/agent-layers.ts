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
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

// These maps contain definitions and callbacks, not configuration to merge recursively.
const opaqueOptions = new Set(["messages.meta", "messages.state", "invocations", "runtime", "driver.output", "driver.model", "driver.launch"])
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
export function resolveAgentLayerOptions(input: unknown, ownsWorkspace: (settings: AgentSettings) => boolean): unknown {
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
    const settings = merge(defaults, inheritedOverrides, "")
    if (!record(settings)) throw new TypeError("[vitehub] Invalid Agent layer options.")
    const { workspace: discoveredWorkspace, ...discoveryDefaults } = inherited.defaults ?? {}
    // Inspect final settings before discovery defaults can create Workspace access.
    // SAFETY: These settings combine a registered definition with its overrides.
    const applicableDefaults = ownsWorkspace(settings as AgentSettings)
      ? { ...discoveryDefaults, workspace: discoveredWorkspace }
      : discoveryDefaults
    const resolved = merge(applicableDefaults, settings, "")
    if (!record(resolved)) throw new TypeError("[vitehub] Invalid Agent layer options.")
    // SAFETY: Resolved settings merge a registered definition with its overrides.
    rememberLayerMetadata(resolved, { options: resolved as AgentSettings, configured: { ...configured, options, overrides: inheritedOverrides }, defaults: inherited.defaults, parent })
    // Preserve application-owned decorations from the configure result on every reconfiguration.
    // SAFETY: resolved is the freshly merged Agent definition settings object.
    copyDefinitionDecorations(asMetadataTarget(definition), asMetadataTarget(resolved))
    return resolved
  }
  const { name: _parentName, ...defaults } = layerMetadata(parent)!.options
  const resolved = merge(defaults, overrides, "")
  if (!record(resolved)) throw new TypeError("[vitehub] Invalid Agent layer options.")
  // SAFETY: Resolved settings merge a registered definition with its overrides.
  rememberLayerMetadata(resolved, { options: resolved as AgentSettings, defaults: inherited.defaults, parent })
  return resolved
}

export type DefinitionDecorationCarrier = Record<PropertyKey, unknown>

export function copyDefinitionDecorations(source: DefinitionDecorationCarrier, target: DefinitionDecorationCarrier): void {
  const frameworkProperties = new Set<PropertyKey>([
    "options", "__vitehubAgentSettings", "__vitehubWorkspaceAgent", "__vitehubWorkspaceAgentOptions", agentLayerMetadata,
    "resolve", "run", "health", "status", "box", "capabilities", "channels", "chat", "cli", "description",
    "driver", "hooks", "invoker", "invocations", "messages", "name", "runtime", "runEvents", "uiMessageStream", "version", "workspace",
    "bindings", "commit", "loaders", "plugins", "publish", "rootDir", "rules", "sourceRootDir", "sources", "store", "mode",
    Symbol.for("vitehub.baseAgentResolve"), Symbol.for("vitehub.baseAgentDefinitionResolve"),
    Symbol.for("vitehub.baseAgentCapabilitiesResolver"), Symbol.for("vitehub.baseAgentModel"),
    Symbol.for("vitehub.baseAgentDriverKind"), Symbol.for("vitehub.baseAgentDriver"),
    Symbol.for("vitehub.baseAgentOutput"), Symbol.for("vitehub.syntheticWorkspaceRun"),
  ])
  for (const key of Reflect.ownKeys(source)) {
    // Rebuild framework fields from layer settings instead of copying derived runtime state.
    if (frameworkProperties.has(key)) continue
    // Resolved settings and explicit overrides take precedence over callback decorations.
    if (Object.prototype.hasOwnProperty.call(target, key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor) Object.defineProperty(target, key, descriptor)
  }
}

export function rememberAgentLayerOptions<T extends AgentDefinition>(definition: T, options: AgentSettings, source: AgentSettings = options): T {
  const inherited = layerMetadata(source)
  // SAFETY: Agent definitions are mutable metadata carriers owned by this package.
  const metadataTarget = asMetadataTarget(definition)
  rememberLayerMetadata(metadataTarget, { options: { ...options }, configured: inherited?.configured, defaults: inherited?.defaults })
  copyDefinitionDecorations(asMetadataTarget(source), metadataTarget)
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
  return mergePresetOptionsWithMemo(parent, child, new WeakMap(), new WeakMap(), new WeakMap(), new WeakMap())
}

function mergePresetOptionsWithMemo(parent: Record<string, unknown>, child: Record<string, unknown> | undefined, memo: WeakMap<object, unknown>, pairMemo: WeakMap<object, WeakMap<object, Record<string, unknown>>>, active: WeakMap<object, unknown>, childMemo: WeakMap<object, unknown>): Record<string, unknown> {
  // Cloning an unchanged graph preserves aliases without reusing an overridden occurrence.
  if (!child || Reflect.ownKeys(parent).length === 0) {
    // SAFETY: The source is a record and cloning preserves its shape.
    return clonePresetOption(child ?? parent, child ? childMemo : memo, active) as Record<string, unknown>
  }
  const existing = pairMemo.get(parent)?.get(child)
  if (existing) return existing
  // SAFETY: Object.create result is immediately populated as a property-key record.
  const result: Record<string | symbol, unknown> = Object.create(Object.getPrototypeOf(parent)) as Record<string | symbol, unknown>
  let byChild = pairMemo.get(parent)
  if (!byChild) { byChild = new WeakMap(); pairMemo.set(parent, byChild) }
  byChild.set(child, result)
  const previousParent = active.get(parent)
  const previousChild = active.get(child)
  active.set(parent, result)
  active.set(child, result)
  // Clones within one override may point back to its result. Keep those clones
  // separate from the same defaults inherited by an unmodified sibling.
  const localMemo = new WeakMap<object, unknown>()
  for (const key of new Set([...Reflect.ownKeys(parent), ...Reflect.ownKeys(child)])) {
    const parentDescriptor = Object.getOwnPropertyDescriptor(parent, key)
    const childDescriptor = Object.getOwnPropertyDescriptor(child, key)
    const overridden = childDescriptor !== undefined && (!("value" in childDescriptor) || childDescriptor.value !== undefined)
    const descriptor = overridden ? childDescriptor : parentDescriptor
    if (!descriptor) continue
    if ("value" in descriptor) {
      // SAFETY: Data descriptors contain arbitrary option values.
      const value: unknown = descriptor.value
      // SAFETY: Only data descriptors participate in recursive option merging.
      const parentValue: unknown = parentDescriptor?.value
      descriptor.value = overridden && record(value) && record(parentValue)
        ? mergePresetOptionsWithMemo(parentValue, value, localMemo, pairMemo, active, childMemo)
        : clonePresetOption(value, overridden ? childMemo : localMemo, active)
    }
    Object.defineProperty(result, key, descriptor)
  }
  if (previousParent === undefined) active.delete(parent)
  else active.set(parent, previousParent)
  if (previousChild === undefined) active.delete(child)
  else active.set(child, previousChild)
  return result
}

function clonePresetOption(value: unknown, memo = new WeakMap<object, unknown>(), active = new WeakMap<object, unknown>()): unknown {
  if (value === null || (!hasRuntimeType(value, "object") && !hasRuntimeType(value, "function"))) return value
  // Functions are atomic option values; preserve callback identity rather than
  // rejecting them as unsupported objects.
  if (hasRuntimeType(value, "function")) return value
  if (active.has(value)) return active.get(value)
  if (memo.has(value)) return memo.get(value)
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return value
    // SAFETY: Array construction with the source length produces an indexed option container.
    const clone = new Array(value.length) as unknown[]
    memo.set(value, clone)
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) continue
      if ("value" in descriptor) {
        // SAFETY: Data descriptors contain arbitrary option values.
        descriptor.value = clonePresetOption(descriptor.value as unknown, memo, active)
      }
      Object.defineProperty(clone, key, descriptor)
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length")
    if (lengthDescriptor) Object.defineProperty(clone, "length", lengthDescriptor)
    return clone
  }
  if (value instanceof Date) { const clone = new Date(value.getTime()); memo.set(value, clone); return clone }
  if (value instanceof Map) {
    if (Object.getPrototypeOf(value) !== Map.prototype) return value
    const clone = new Map()
    memo.set(value, clone)
    for (const [key, entry] of value) clone.set(clonePresetOption(key, memo, active), clonePresetOption(entry, memo, active))
    return clone
  }
  if (value instanceof Set) {
    if (Object.getPrototypeOf(value) !== Set.prototype) return value
    const clone = new Set()
    memo.set(value, clone)
    for (const entry of value) clone.add(clonePresetOption(entry, memo, active))
    return clone
  }
  if (value instanceof RegExp) { const clone = new RegExp(value.source, value.flags); clone.lastIndex = value.lastIndex; memo.set(value, clone); return clone }
  if (value instanceof URL) { const clone = new URL(value.href); memo.set(value, clone); return clone }
  if (value instanceof URLSearchParams) { const clone = new URLSearchParams(value.toString()); memo.set(value, clone); return clone }
  if (value instanceof ArrayBuffer) { const clone = value.slice(0); memo.set(value, clone); return clone }
  const sharedArrayBuffer = globalThis.SharedArrayBuffer
  if (sharedArrayBuffer && value instanceof sharedArrayBuffer) {
    const source = value
    const clone = new sharedArrayBuffer(source.byteLength)
    const cloneBytes = new Uint8Array(clone)
    const sourceBytes = new Uint8Array(value)
    cloneBytes.set(sourceBytes)
    memo.set(value, clone)
    return clone
  }
  if (ArrayBuffer.isView(value)) {
    // SAFETY: Node exposes Buffer as a constructor with the documented isBuffer/from API.
    if ("Buffer" in globalThis && (globalThis as { Buffer: typeof Buffer }).Buffer.isBuffer(value)) {
      // SAFETY: Buffer values are Uint8Array views by the preceding intrinsic check.
      const sourceBuffer = value as Uint8Array
      // SAFETY: Uint8Array intrinsic accessor returns the backing ArrayBuffer.
      const sourceBacking = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "buffer")!.get!.call(sourceBuffer) as ArrayBuffer
      // SAFETY: Uint8Array intrinsic accessor returns a numeric offset.
      const sourceOffset = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "byteOffset")!.get!.call(sourceBuffer) as number
      // SAFETY: Uint8Array intrinsic accessor returns a numeric length.
      const sourceLength = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "byteLength")!.get!.call(sourceBuffer) as number
      // SAFETY: cloning an ArrayBuffer yields an ArrayBuffer.
      // SAFETY: clonePresetOption returns the same built-in type for ArrayBuffer inputs.
      const clonedBacking = clonePresetOption(sourceBacking, memo, active) as ArrayBuffer
      // SAFETY: Node's Buffer binding is present in this branch and accepts the cloned backing range.
      const clone = (globalThis as { Buffer: typeof Buffer }).Buffer.from(clonedBacking, sourceOffset, sourceLength)
      memo.set(value, clone)
      return clone
    }
    if (value instanceof DataView) {
      // SAFETY: DataView intrinsic accessors avoid shadowable instance properties.
      // SAFETY: DataView intrinsic buffer accessor returns an ArrayBuffer.
      const buffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")!.get!.call(value) as ArrayBuffer
      // SAFETY: DataView intrinsic byteOffset accessor returns a number.
      const byteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset")!.get!.call(value) as number
      // SAFETY: DataView intrinsic byteLength accessor returns a number.
      const byteLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get!.call(value) as number
      // SAFETY: buffer is obtained from the intrinsic DataView accessor and clonePresetOption preserves ArrayBuffer values.
      const clonedBuffer = clonePresetOption(buffer, memo, active) as ArrayBuffer
      const clone = new DataView(clonedBuffer, byteOffset, byteLength)
      memo.set(value, clone)
      return clone
    }
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
    // SAFETY: %TypedArray% intrinsic accessors work for every typed-array view.
    const buffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!.call(value) as ArrayBuffer
    const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!.call(value)
    const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!.call(value)
    // SAFETY: clonePresetOption returns the same built-in type for ArrayBuffer inputs.
    const clonedBuffer = clonePresetOption(buffer, memo, active) as ArrayBuffer
    // SAFETY: Every entry is a built-in typed-array constructor; filtering removes unavailable BigInt variants.
    const constructors = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, "BigInt64Array" in globalThis ? BigInt64Array : undefined, "BigUint64Array" in globalThis ? BigUint64Array : undefined].filter(Boolean) as any[]
    const TypedArray = constructors.find((ctor) => value instanceof ctor)
    if (!TypedArray) throw new TypeError("[vitehub] Agent preset options must contain cloneable built-in values.")
    const clone = new TypedArray(clonedBuffer, byteOffset, byteLength / TypedArray.BYTES_PER_ELEMENT)
    memo.set(value, clone)
    return clone
  }
  if (record(value)) {
    const prototype = Object.getPrototypeOf(value)
    // SAFETY: Object values are cloned with their prototype and own descriptors.
    // SAFETY: The prototype is restricted to plain objects or null above.
    const clone = Object.create(prototype) as Record<string, unknown>
    memo.set(value, clone)
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) continue
      if ("value" in descriptor) {
        // SAFETY: Value descriptors expose an arbitrary option value for recursive cloning.
        descriptor.value = clonePresetOption(descriptor.value as unknown, memo, active)
      }
      Object.defineProperty(clone, key, descriptor)
    }
    return clone
  }
  // Preserve internal slots and identity for other branded option values.
  return value
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
  copyDefinitionDecorations(asMetadataTarget(definition), asMetadataTarget(configured))
  inheritColocatedSkills(asMetadataTarget(definition), asMetadataTarget(configured))
  inheritAgentLayerOptions(asMetadataTarget(definition), asMetadataTarget(configured))
  rememberConfiguredLayer(configured, { options, configure, overrides: {} })
  return configured
}

export function asMetadataTarget(value: unknown): Record<string, unknown> {
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
