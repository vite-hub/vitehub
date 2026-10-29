import { mergeConfig } from "vite"

import type { ConfigEnv, Plugin, PluginOption, UserConfig } from "vite"

import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

type ConfigHandler = (this: unknown, config: UserConfig, env: ConfigEnv) => unknown
interface Held { handler: ConfigHandler | undefined, hook: Plugin["config"], plugin: Plugin, selected: boolean }

// Nitro reads `config.nitro` once, in the `config` hook of `nitro:init`. The other two share its context, so all three move together.
const nitroConfigPlugins = ["nitro:init", "nitro:env", "nitro:main"]
const marker = "vite-hub/nitro-order"

async function flatten(options: readonly PluginOption[] | undefined): Promise<Plugin[]> {
  const plugins: Plugin[] = []
  for (const option of await Promise.all(options ?? [])) {
    if (Array.isArray(option)) plugins.push(...await flatten(option))
    else if (option && typeof option === "object" && "name" in option) plugins.push(option)
  }
  return plugins
}

function handlerOf(hook: Plugin["config"]): ConfigHandler | undefined {
  const handler: unknown = typeof hook === "object" ? hook.handler : hook
  return typeof handler === "function" ? handler as ConfigHandler : undefined
}

function unsupportedHook(): Error {
  return viteHubErrorDiagnostics.VITE_HUB_R0135({ message: "[vitehub] This version of Nitro cannot run after vitehub() when nitro() comes first. Put vitehub() before nitro() in plugins." })
}

/**
 * Makes `plugins: [nitro(), vitehub()]` build like `[vitehub(), nitro()]`. Vite runs `config` hooks in plugin order and Nitro
 * reads `config.nitro` in its own, so every handler, plugin, and asset that ViteHub adds after it is lost. When `nitro()` comes
 * first, the first plugin holds Nitro's `config` hooks back and the second runs them once the rest of ViteHub's have run.
 */
export function nitroOrderPlugins(): Plugin[] {
  let held: Held[] = []
  let early: Plugin[] = []
  return [
    {
      name: marker,
      config: {
        order: "pre",
        async handler(config) {
          early = []
          const plugins = await flatten(config.plugins)
          const self = plugins.findLastIndex(plugin => plugin.name === marker)
          const nitro = plugins.slice(0, Math.max(self, 0)).filter(plugin => nitroConfigPlugins.includes(plugin.name) && plugin.config !== undefined)
          if (nitro.length === 0) return
          const next: Held[] = []
          for (const plugin of nitro) {
            const handler = handlerOf(plugin.config)
            // Such a hook can already have run. Check Vite's resolved selection before rejecting it.
            if (typeof plugin.config === "object" && plugin.config.order === "pre") {
              early.push(plugin)
              continue
            }
            next.push({ handler, hook: plugin.config, plugin, selected: false })
          }
          for (const entry of next) {
            // Vite has already evaluated `apply`. Only hooks it actually invokes may be replayed.
            entry.plugin.config = () => { entry.selected = true }
          }
          held = next
        },
      },
      configResolved: {
        order: "pre",
        handler(config) {
          if (early.some(plugin => config.plugins.includes(plugin))) throw unsupportedHook()
        },
      },
    },
    {
      name: `${marker}/run`,
      enforce: "post",
      config: {
        order: "post",
        async handler(config, env) {
          const pending = held
          held = []
          let delta: UserConfig = {}
          let current = config
          try {
            for (const { handler, selected } of pending) {
              if (!selected) continue
              if (!handler) throw unsupportedHook()
              const result = await handler.call(this, current, env)
              if (result && result !== current) {
                delta = mergeConfig(delta, result as UserConfig)
                current = mergeConfig(config, delta)
              }
            }
          }
          finally {
            for (const { hook, plugin } of pending) plugin.config = hook
          }
          return delta
        },
      },
    },
  ]
}
