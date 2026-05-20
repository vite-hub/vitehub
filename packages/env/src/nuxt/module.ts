import { addServerImports, defineNuxtModule } from "@nuxt/kit"
import { assertNoNitroModule, assertNoVitePlugin, hasNitroModule } from "@vitehub/internal/nitro"
import { envNitro } from "../nitro/module.ts"
import type { NitroConfig, NitroModuleInput } from "nitro/types"
import type { NuxtModule } from "@nuxt/schema"

import type { EnvIntegrationOptions, EnvNitroConfigOptions } from "../types.ts"

const NITRO_MODULE_ID = "@vitehub/env/nitro"
const NITRO_MODULE_NAME = "@vitehub/env"
const NUXT_MODULE_ID = "@vitehub/env/nuxt"
const VITE_PLUGIN_NAME = "@vitehub/env/vite"

type EnvNitroConfig = NitroConfig & {
  env?: EnvNitroConfigOptions
  modules?: NitroModuleInput[]
}

type EnvVitePluginConfig = {
  plugins?: unknown
}

function hasEnvNitroModule(entry: NitroModuleInput): boolean {
  return hasNitroModule(entry, NITRO_MODULE_ID, NITRO_MODULE_NAME)
}

function createEnvNitroModuleEntry(options: EnvIntegrationOptions): NitroModuleInput {
  return Object.keys(options).length === 0 ? NITRO_MODULE_ID : envNitro(options)
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
  meta: { name: NUXT_MODULE_ID },
  async setup(inlineOptions = {}, nuxt) {
    if (nuxt.options.env === false) {
      return
    }

    const nitro = (nuxt.options.nitro ||= {}) as EnvNitroConfig
    await assertNoVitePlugin(nuxt.options.vite as EnvVitePluginConfig | undefined, VITE_PLUGIN_NAME, NUXT_MODULE_ID)
    assertNoNitroModule(nitro, NITRO_MODULE_ID, NITRO_MODULE_NAME, NUXT_MODULE_ID)
    installEnvNitroModule(nitro, nuxt.options.env, inlineOptions)
    nuxt.hook("nitro:config", (config) => {
      const env = nuxt.options.env
      if (env !== false) {
        installEnvNitroModule(config as EnvNitroConfig, env, inlineOptions)
      }
    })

    addServerImports({
      from: "#vitehub/env/server",
      name: "useServerEnv",
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
