import { defineNuxtModule } from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
import { applyServerImportsToNitro } from './server-imports'
import { getViteHubFeatureServerImports } from './vitehub-server-imports'

export interface NuxtFeatureModuleOptions<_TConfig extends object> {
  feature: string
  installWithoutConfig?: boolean
  resolveNitroConfig?: (config: _TConfig, nuxt: Nuxt) => _TConfig | undefined
  onInstalled?: (context: { nuxt: Nuxt, config: _TConfig }) => void | Promise<void>
}

export function resolveFeatureNuxtModuleOptions<TConfig extends object>(
  topLevelOptions: TConfig | false | undefined,
  inlineOptions: TConfig | undefined,
) {
  if (topLevelOptions === false)
    return undefined

  if (typeof topLevelOptions !== 'undefined')
    return topLevelOptions

  if (inlineOptions && Object.keys(inlineOptions).length > 0)
    return inlineOptions

  return undefined
}

export function applyFeatureNitroConfig<TConfig extends object>(
  nitro: Record<string, any>,
  feature: string,
  serverImports: ReturnType<typeof getViteHubFeatureServerImports>,
  config?: TConfig,
) {
  nitro.modules ||= []
  nitro.imports ??= {}

  const modulePath = `@vitehub/${feature}/nitro`
  if (!nitro.modules.includes(modulePath))
    nitro.modules.push(modulePath)

  if (typeof config !== 'undefined')
    nitro[feature] = { ...(nitro[feature] || {}), ...config }

  applyServerImportsToNitro(nitro, serverImports)
}

export function installFeatureNitroModule<TConfig extends object>(nuxt: Nuxt, feature: string, config?: TConfig) {
  const nuxtOptions = nuxt.options as Record<string, any>
  const nitro = nuxtOptions.nitro ||= {}
  const serverImports = getViteHubFeatureServerImports(feature as never, nuxtOptions)

  applyFeatureNitroConfig(nitro, feature, serverImports, config)

  ;(nuxt.hook as any)('nitro:config', (nitroConfig: Record<string, any>) => {
    applyFeatureNitroConfig(nitroConfig as Record<string, any>, feature, serverImports, config)
  })
}

export function createFeatureNuxtModule<TConfig extends object>(opts: NuxtFeatureModuleOptions<TConfig>) {
  const { feature, installWithoutConfig = true, onInstalled, resolveNitroConfig } = opts

  return defineNuxtModule<any>({
    meta: { name: `@vitehub/${feature}/nuxt`, configKey: feature },
    defaults: undefined,
    async setup(options, nuxt) {
      const nuxtOptions = nuxt.options as Record<string, any>
      const topLevelOptions = nuxtOptions[feature] as TConfig | false | undefined
      if (topLevelOptions === false)
        return

      const moduleOptions = resolveFeatureNuxtModuleOptions(
        topLevelOptions,
        options as TConfig | undefined,
      )

      const nitroConfig = resolveNitroConfig
        ? typeof moduleOptions === 'undefined'
            ? undefined
            : resolveNitroConfig(moduleOptions, nuxt)
        : moduleOptions

      if (!installWithoutConfig && typeof nitroConfig === 'undefined')
        return

      installFeatureNitroModule(nuxt, feature, nitroConfig)

      if (typeof nitroConfig !== 'undefined')
        await onInstalled?.({ nuxt, config: nitroConfig })
    },
  })
}
