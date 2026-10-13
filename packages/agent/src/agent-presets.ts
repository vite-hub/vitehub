import type { AgentDefinition } from "./types.ts"

/** Partial option overrides. Arrays, callbacks, and method-bearing values must be complete. */
export type AgentPresetOptions<T> = { [K in keyof T]?: AgentPresetOptionValue<T[K]> }

type RequiredMethodKeys<T> = { [K in keyof T]-?: T[K] extends (...args: never[]) => unknown ? K : never }[keyof T]

type AgentPresetOptionValue<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly unknown[] ? T
    : T extends Date | Map<unknown, unknown> | Set<unknown> | RegExp | URL | URLSearchParams | ArrayBuffer | ArrayBufferView | SharedArrayBuffer ? T
      // TypeScript cannot distinguish class methods from record callbacks.
      // Require complete method-bearing values to preserve instance contracts.
      : T extends object ? [RequiredMethodKeys<T>] extends [never] ? AgentPresetOptions<T> : T
        : T

/** An ordinary Agent Definition with typed preset configuration. */
export type ConfiguredAgentDefinition<TOptions extends object, TDefinition = AgentDefinition, TConfigKey extends string = never> = Omit<TDefinition, "options"> & {
  readonly options: Readonly<TOptions>
} & ([TConfigKey] extends [never] ? {} : { readonly configKey: TConfigKey })

import { hasRuntimeType, isRuntimeRecord } from "./internal/runtime-type.ts"

/** Resolve a local name before the normal Agent layer composition. */
export function resolveNamedAgentPresetOptions(input: unknown): unknown {
  if (!isRuntimeRecord(input)) return input
  if (!("presets" in input) && !("preset" in input)) return input
  const { preset, presets, ...options } = input
  if ("extends" in options) {
    throw new TypeError("[vitehub] Select one Agent parent with preset or extends, not both.")
  }
  if (!hasRuntimeType(preset, "string") || !preset.trim()) {
    throw new TypeError("[vitehub] defineAgent({ presets }) requires a non-empty preset name.")
  }
  if (!presets || !hasRuntimeType(presets, "object") || Array.isArray(presets) || !Object.hasOwn(presets, preset)) {
    throw new TypeError(`[vitehub] Agent preset "${preset}" is not defined in presets.`)
  }
  return { ...options, extends: Reflect.get(presets, preset) }
}

/** The named configuration block declared by a configured preset. */
export type AgentPresetConfig<TDefinition> = TDefinition extends { configKey: infer TKey extends string, options: infer TOptions extends object }
  ? { [K in TKey]?: AgentPresetOptions<TOptions> }
  : {}

function presetOptionsRecord(value: unknown): value is Record<string, unknown> {
  return isRuntimeRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

/** Normalize module-style selection before ordinary Agent layer composition. */
export function resolveAgentPresetExtension(
  input: unknown,
  resolve: (name: string) => unknown,
  mergeOptions: (parent: Record<string, unknown>, child?: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  const selected = resolveNamedAgentPresetOptions(input)
  if (!isRuntimeRecord(selected) || !("extends" in selected)) return selected
  const { extends: extension, ...overrides } = selected
  let parent: unknown = extension
  let tupleOptions: Record<string, unknown> | undefined
  if (Array.isArray(extension)) {
    if (extension.length !== 2 || !presetOptionsRecord(extension[1])) {
      throw new TypeError("[vitehub] Agent extends tuple requires [preset, options] with an options object.")
    }
    parent = extension[0]
    tupleOptions = extension[1]
  }
  if (hasRuntimeType(parent, "string")) parent = resolve(parent)
  const configKey: unknown = parent && hasRuntimeType(parent, "object") ? Reflect.get(parent, "configKey") : undefined
  let namedOptions: Record<string, unknown> | undefined
  if (hasRuntimeType(configKey, "string") && Object.hasOwn(overrides, configKey)) {
    const value = overrides[configKey]
    if (value !== undefined && !presetOptionsRecord(value)) throw new TypeError(`[vitehub] Agent ${configKey} options must be an object.`)
    namedOptions = value
    delete overrides[configKey]
  }
  if (Object.hasOwn(overrides, "options") && (tupleOptions || namedOptions)) {
    throw new TypeError("[vitehub] Select preset options with options or a named block/tuple, not both.")
  }
  const supplied = tupleOptions ? mergeOptions(namedOptions ?? {}, tupleOptions) : namedOptions
  if (supplied) {
    const defaults: unknown = parent && hasRuntimeType(parent, "object") ? Reflect.get(parent, "options") : undefined
    if (isRuntimeRecord(defaults)) for (const key of Object.keys(supplied)) {
      if (!Object.hasOwn(defaults, key)) throw new TypeError(`[vitehub] Unknown Agent ${hasRuntimeType(configKey, "string") ? configKey : "preset"} option "${key}".`)
    }
    overrides.options = supplied
  }
  return { ...overrides, extends: parent }
}
