import type { AgentDefinition } from "./types.ts"

/** Partial option overrides. Arrays and callbacks are replaced as whole values. */
export type AgentPresetOptions<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly unknown[] ? T
    : T extends object ? { [K in keyof T]?: AgentPresetOptions<T[K]> }
      : T

/** An ordinary Agent Definition with typed preset configuration. */
export type ConfiguredAgentDefinition<TOptions extends object, TDefinition = AgentDefinition> = Omit<TDefinition, "options"> & {
  readonly options: Readonly<TOptions>
}

import { hasRuntimeType, isRuntimeRecord } from "./internal/runtime-type.ts"

/** Resolve a local name before the normal Agent layer composition. */
export function resolveNamedAgentPresetOptions(input: unknown): unknown {
  if (!isRuntimeRecord(input)) return input
  if (!("presets" in input) && !hasRuntimeType(input.preset, "string")) return input
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
