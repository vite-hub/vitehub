import { fileURLToPath } from "node:url"

/**
 * One durability reporter that a primitive's Vite plugin contributes through `vitehub.durability`. The Node server
 * imports `export` from `module` at boot and calls it with `input` and the server environment. It returns the
 * `Durability` lines of `@vite-hub/runtime/durability`.
 */
export interface DurabilityContribution {
  /** The absolute file of the reporter module. */
  module: string
  export: string
  /**
   * The resolved configuration of the primitive, as plain JSON data. The build writes it into the server with
   * `JSON.stringify`, so do not put credentials here.
   */
  input: unknown
}

/** The `vitehub.durability` field of a primitive's Vite plugin. */
export interface DurabilityPluginMetadata {
  /** Called after Vite resolves the config. Return an empty list when the primitive is off. */
  durability?: () => readonly DurabilityContribution[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Object(value) === value && !Array.isArray(value)
}

/** The durability reporters of the resolved Vite plugins, in plugin order. */
export function collectDurabilityContributions(plugins: readonly unknown[]): DurabilityContribution[] {
  const collected: DurabilityContribution[] = []
  for (const plugin of plugins) {
    if (!isObject(plugin) || !isObject(plugin.vitehub)) continue
    const durability = plugin.vitehub.durability
    if (!(durability instanceof Function)) continue
    const entries: unknown = durability()
    if (!Array.isArray(entries)) continue
    for (const entry of entries as unknown[]) {
      if (isObject(entry) && typeof entry.module === "string" && typeof entry.export === "string") {
        collected.push({ module: entry.module, export: entry.export, input: entry.input })
      }
    }
  }
  return collected
}

/** The `durability` module next to the Vite plugin module at `importMetaUrl`, in source and in `dist`. */
export function durabilityModuleFile(importMetaUrl: string): string {
  return fileURLToPath(new URL(importMetaUrl.endsWith(".ts") ? "./durability.ts" : "./durability.js", importMetaUrl))
}
