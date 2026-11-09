import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

/**
 * One durability reporter that a primitive's Vite plugin contributes through `vitehub.durability`. The Node server
 * imports `export` from `module` at boot and calls it with `input` and the server environment. It returns the
 * `Durability` lines of `@vite-hub/runtime/durability`.
 */
export interface DurabilityContribution {
  /** The primitive that the reporter describes, such as `kv`. Other reporters find its result by this id. */
  primitive: string
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

/** The durability reporters of the Vite plugins, in plugin order. Nested plugin lists are read too. */
export function collectDurabilityContributions(plugins: readonly unknown[]): DurabilityContribution[] {
  const collected: DurabilityContribution[] = []
  const visit = (plugin: unknown): void => {
    if (Array.isArray(plugin)) {
      for (const item of plugin) visit(item)
      return
    }
    if (!isObject(plugin) || !isObject(plugin.vitehub)) return
    const durability = plugin.vitehub.durability
    if (!(durability instanceof Function)) return
    const entries: unknown = durability()
    if (!Array.isArray(entries)) return
    for (const entry of entries as unknown[]) {
      if (isObject(entry) && typeof entry.primitive === "string" && typeof entry.module === "string" && typeof entry.export === "string") {
        collected.push({ primitive: entry.primitive, module: entry.module, export: entry.export, input: entry.input })
      }
    }
  }
  visit(plugins)
  return collected
}

/** The `durability` module next to the Vite plugin module at `importMetaUrl`, in source and in `dist`. */
export function durabilityModuleFile(importMetaUrl: string): string {
  return fileURLToPath(new URL(importMetaUrl.endsWith(".ts") ? "./durability.ts" : "./durability.js", importMetaUrl))
}

/** The file of a reporter module that a package exports, such as `@vite-hub/workspace/durability`, resolved from `importMetaUrl`. */
export function resolveDurabilityModule(importMetaUrl: string, specifier: string): string {
  return createRequire(importMetaUrl).resolve(specifier)
}
