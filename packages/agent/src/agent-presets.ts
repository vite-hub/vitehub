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
export type ConfiguredAgentDefinition<TOptions extends object, TDefinition = AgentDefinition> = Omit<TDefinition, "options"> & {
  readonly options: Readonly<TOptions>
}

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
