import { nitro } from "nitro/vite"

import type { ConfigEnv, Plugin, PluginOption, UserConfig } from "vite"

const includedNitroPlugins = new WeakSet<object>()

function flattenPlugins(option: PluginOption): Plugin[] {
  if (Array.isArray(option)) return option.flatMap(flattenPlugins)
  return option && typeof option === "object" && "name" in option ? [option] : []
}

function findNitroMain(value: unknown, own: Plugin | undefined): boolean {
  if (Array.isArray(value)) return value.some(entry => findNitroMain(entry, own))
  return value !== own && Boolean(value) && typeof value === "object" && Reflect.get(value, "name") === "nitro:main"
}

function applies(apply: Plugin["apply"], config: UserConfig, env: ConfigEnv): boolean {
  if (typeof apply === "function") return apply(config, env)
  return apply === undefined || apply === env.command
}

/**
 * Returns the Vite plugins of Nitro, the host output of `vitehub()`. They apply only when the app does not add
 * `nitro()` itself, so an app that still adds it gets one Nitro.
 */
export function includedNitro(): Plugin[] {
  const plugins = flattenPlugins(nitro())
  const main = plugins.find(plugin => plugin.name === "nitro:main")
  for (const plugin of plugins) {
    const apply = plugin.apply
    plugin.apply = (config, env) => !findNitroMain(config.plugins, main) && applies(apply, config, env)
    includedNitroPlugins.add(plugin)
  }
  return plugins
}

/** Tells if `vitehub()` added this Nitro plugin. Nuxt removes them, because Nuxt runs its own Nitro. */
export function isIncludedNitroPlugin(plugin: object): boolean {
  return includedNitroPlugins.has(plugin)
}
