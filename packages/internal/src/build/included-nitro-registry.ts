import type { Plugin } from "vite"

const includedKey = Symbol.for("vitehub.included-nitro")
// SAFETY: One process-wide set, so the copies of this module that `vite-hub` and `@vite-hub/comments` bundle agree.
const scope = globalThis as typeof globalThis & { [includedKey]?: WeakSet<object> }
const includedNitroPlugins = scope[includedKey] ??= new WeakSet<object>()

/** Records a Nitro plugin that a ViteHub package included. */
export function markIncludedNitroPlugin(plugin: Plugin): void {
  includedNitroPlugins.add(plugin)
}

/**
 * Tells if a ViteHub package added this Nitro plugin. Nuxt removes them, because Nuxt runs its own Nitro. This module
 * does not import `nitro/vite`, so `vite-hub/nuxt` can check plugins without loading Nitro's Vite plugin.
 */
export function isIncludedNitroPlugin(plugin: object): boolean {
  return includedNitroPlugins.has(plugin)
}
