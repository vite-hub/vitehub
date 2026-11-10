import { assertKnownPresetOptions, isPresetOptionsRecord, readPresetSelection } from "@vite-hub/internal/presets"

import { isRuntimeRecord } from "./internal/runtime-type.ts"

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

/** The named configuration block declared by a configured preset. */
export type AgentPresetConfig<TDefinition> = TDefinition extends { configKey: infer TKey extends string, options: infer TOptions extends object }
  ? { [K in TKey]?: AgentPresetOptions<TOptions> }
  : {}

/** Normalize module-style selection before ordinary Agent layer composition. */
export function resolveAgentPresetExtension(
  input: unknown,
  resolve: (name: string) => unknown,
  mergeOptions: (parent: Record<string, unknown>, child?: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (isRuntimeRecord(input) && ("preset" in input || "presets" in input)) {
    throw new TypeError("[vitehub] defineAgent() has no preset or presets option. Pass the parent Agent Definition as extends, such as defineAgent({ extends: babysitter }).")
  }
  if (!isRuntimeRecord(input) || !("extends" in input)) return input
  const { extends: extension, ...overrides } = input
  const selection = readPresetSelection(extension, "Agent")
  const tupleOptions = selection.options
  let parent = selection.preset
  if (typeof parent === "string") parent = resolve(parent)
  const configKey: unknown = parent && typeof parent === "object" ? Reflect.get(parent, "configKey") : undefined
  let namedOptions: Record<string, unknown> | undefined
  if (typeof configKey === "string" && Object.hasOwn(overrides, configKey)) {
    const value = overrides[configKey]
    if (value !== undefined && !isPresetOptionsRecord(value)) throw new TypeError(`[vitehub] Agent ${configKey} options must be an object.`)
    namedOptions = value
    delete overrides[configKey]
  }
  if (Object.hasOwn(overrides, "options") && (tupleOptions || namedOptions)) {
    throw new TypeError("[vitehub] Select preset options with options or a named block/tuple, not both.")
  }
  const supplied = tupleOptions ? mergeOptions(namedOptions ?? {}, tupleOptions) : namedOptions
  if (supplied) {
    const defaults: unknown = parent && typeof parent === "object" ? Reflect.get(parent, "options") : undefined
    assertKnownPresetOptions(defaults, supplied, `Agent ${typeof configKey === "string" ? configKey : "preset"}`)
    overrides.options = supplied
  }
  return { ...overrides, extends: parent }
}
