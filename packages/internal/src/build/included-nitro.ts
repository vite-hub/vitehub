import { nitro } from "nitro/vite"

import type { ConfigEnv, Plugin, PluginOption, UserConfig } from "vite"

const includedKey = Symbol.for("vitehub.included-nitro")
// SAFETY: One process-wide set, so the copies of this module that `vite-hub` and `@vite-hub/comments` bundle agree.
const scope = globalThis as typeof globalThis & { [includedKey]?: WeakSet<object> }
const includedNitroPlugins = scope[includedKey] ??= new WeakSet<object>()

function flattenPlugins(option: PluginOption): Plugin[] {
  if (Array.isArray(option)) return option.flatMap(flattenPlugins)
  return option && typeof option === "object" && "name" in option ? [option] : []
}

/** Whether the app added `nitro()` itself. Nitro plugins that a ViteHub package included do not count. */
function findAppNitro(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(findAppNitro)
  return value !== null && typeof value === "object" && !includedNitroPlugins.has(value) && Reflect.get(value, "name") === "nitro:main"
}

function applies(apply: Plugin["apply"], config: UserConfig, env: ConfigEnv): boolean {
  if (typeof apply === "function") return apply(config, env)
  return apply === undefined || apply === env.command
}

/**
 * Returns the Vite plugins of Nitro, the server of a ViteHub app. They apply only when the app does not add `nitro()`
 * itself, so an app that still adds it gets one Nitro. `unless` steps aside for another package that includes Nitro.
 */
export function includedNitro(options: { unless?: (config: UserConfig) => boolean } = {}): Plugin[] {
  const plugins = flattenPlugins(nitro())
  for (const plugin of plugins) {
    const apply = plugin.apply
    plugin.apply = (config, env) => !findAppNitro(config.plugins) && !options.unless?.(config) && applies(apply, config, env)
    includedNitroPlugins.add(plugin)
  }
  return plugins
}

/** Tells if a ViteHub package added this Nitro plugin. Nuxt removes them, because Nuxt runs its own Nitro. */
export function isIncludedNitroPlugin(plugin: object): boolean {
  return includedNitroPlugins.has(plugin)
}
