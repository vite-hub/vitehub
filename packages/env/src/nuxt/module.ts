import { addServerImports, defineNuxtModule } from "@nuxt/kit"
import { envNitro } from "../nitro/module.ts"
import type { NitroConfig, NitroModule, NitroModuleInput } from "nitro/types"
import type { NuxtModule } from "@nuxt/schema"

import type { EnvIntegrationOptions, EnvNitroConfigOptions } from "../types.ts"

const NITRO_MODULE_ID = "@vitehub/env/nitro"
const NITRO_MODULE_NAME = "@vitehub/env"
const VITE_PLUGIN_NAME = "@vitehub/env/vite"

type EnvNitroConfig = NitroConfig & {
  env?: EnvNitroConfigOptions
  modules?: NitroModuleInput[]
}

type EnvVitePluginConfig = {
  plugins?: unknown
}

function hasEnvNitroModule(entry: NitroModuleInput): boolean {
  if (entry === NITRO_MODULE_ID) {
    return true
  }
  if (typeof entry !== "object" || entry === null) {
    return false
  }
  const module = "nitro" in entry ? entry.nitro : entry
  return (module as Partial<NitroModule>).name === NITRO_MODULE_NAME
}

function hasEnvVitePlugin(plugin: unknown): boolean {
  if (Array.isArray(plugin)) {
    return plugin.some(hasEnvVitePlugin)
  }
  return typeof plugin === "object" && plugin !== null && "name" in plugin && plugin.name === VITE_PLUGIN_NAME
}

function createEnvNitroModuleEntry(options: EnvIntegrationOptions): NitroModuleInput {
  return Object.keys(options).length === 0 ? NITRO_MODULE_ID : envNitro(options)
}

function assertNoEnvNitroModule(nitro: EnvNitroConfig): void {
  if (nitro.modules?.some(hasEnvNitroModule)) {
    throw new Error("[vitehub] Do not configure @vitehub/env/nitro when using @vitehub/env/nuxt.")
  }
}

function assertNoEnvVitePlugin(vite: EnvVitePluginConfig | undefined): void {
  if (hasEnvVitePlugin(vite?.plugins)) {
    throw new Error("[vitehub] Do not configure @vitehub/env/vite when using @vitehub/env/nuxt.")
  }
}

function installEnvNitroModule(nitro: EnvNitroConfig, env: EnvNitroConfigOptions | undefined, options: EnvIntegrationOptions): void {
  nitro.modules ||= []
  if (!nitro.modules.some(hasEnvNitroModule)) {
    nitro.modules.push(createEnvNitroModuleEntry(options))
  }
  if (env !== undefined) {
    nitro.env = env
  }
}

const envNuxtModule: NuxtModule<EnvIntegrationOptions, EnvIntegrationOptions, false> = defineNuxtModule<EnvIntegrationOptions>({
  meta: { name: "@vitehub/env/nuxt" },
  setup(inlineOptions = {}, nuxt) {
    if (nuxt.options.env === false) {
      return
    }

    const nitro = (nuxt.options.nitro ||= {}) as EnvNitroConfig
    assertNoEnvVitePlugin(nuxt.options.vite as EnvVitePluginConfig | undefined)
    assertNoEnvNitroModule(nitro)
    installEnvNitroModule(nitro, nuxt.options.env, inlineOptions)
    nuxt.hook("nitro:config", (config) => {
      const env = nuxt.options.env
      if (env !== false) {
        installEnvNitroModule(config as EnvNitroConfig, env, inlineOptions)
      }
    })

    addServerImports({
      from: "#vitehub/env/server",
      name: "useSafeRuntimeConfig",
    })
  },
})

export default envNuxtModule

declare module "@nuxt/schema" {
  interface NuxtConfig {
    env?: EnvNitroConfigOptions | false
    nitro?: NitroConfig
  }
  interface NuxtOptions {
    env?: EnvNitroConfigOptions | false
    nitro?: NitroConfig
  }
  interface NuxtHooks {
    "nitro:config": (config: NitroConfig) => void | Promise<void>
  }
}
