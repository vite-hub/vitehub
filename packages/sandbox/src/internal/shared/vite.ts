import {
  createFeatureEngine,
  type FeatureEngine,
  type FeatureStateSource,
  type FeatureViteContext,
  type FeatureViteSetupResult,
} from './feature-engine'
import { mergeUserConfigs } from './vite/config-merge'
import { resolveFeatureViteState, type ResolvedFeatureViteState } from './vite/virtual-modules'

import type { ConfigEnv, Plugin } from 'vite'

export type { FeatureViteContext, FeatureViteSetupResult } from './feature-engine'
export type { FeatureViteState } from './vite/virtual-modules'

export interface FeatureBridgeBundle {
  vite: Plugin
}

type ViteFeatureFactoryOptions<TOptions, TInput, TConfig = TInput> = {
  name: string
  feature: string
  configKey: string
  defaultOptions?: TOptions | (() => TOptions)
  loadDeps?: boolean
  normalizeOptions: (options: TOptions | undefined) => TInput | undefined
  resolveConfig?: (config: TInput, hosting?: string) => TConfig
  assignRuntimeConfig?: (runtimeConfig: Record<string, unknown>, config: TConfig) => void
  readOptions: (config: Record<string, unknown>, env: ConfigEnv) => TOptions | undefined
  setup?: (context: FeatureViteContext<TConfig>) => Promise<FeatureViteSetupResult | void> | FeatureViteSetupResult | void
}

function normalizeViteEngine<TOptions, TInput, TConfig>(
  options: FeatureEngine<TOptions, TInput, TConfig> | ViteFeatureFactoryOptions<TOptions, TInput, TConfig>,
): FeatureEngine<TOptions, TInput, TConfig> {
  if ('readPublicOptions' in options)
    return options

  return createFeatureEngine({
    name: options.name,
    feature: options.feature,
    configKey: options.configKey,
    defaultOptions: options.defaultOptions,
    loadDeps: options.loadDeps,
    normalizeOptions: options.normalizeOptions,
    resolveConfig: options.resolveConfig,
    assignRuntimeConfig: options.assignRuntimeConfig,
    readPublicOptions(source: FeatureStateSource<TOptions>) {
      return options.readOptions(source.userConfig, source.env)
    },
    setupVite: options.setup,
  })
}

export function createFeatureBridgeBundle<TOptions, TInput, TConfig = TInput>(
  options: FeatureEngine<TOptions, TInput, TConfig> | ViteFeatureFactoryOptions<TOptions, TInput, TConfig>,
): FeatureBridgeBundle {
  const engine = normalizeViteEngine(options)
  let state: ResolvedFeatureViteState<TConfig> | undefined
  let rawConfig: Record<string, unknown> = {}
  let rawEnv: ConfigEnv = { command: 'serve', mode: 'development' }

  async function refreshState() {
    state = await resolveFeatureViteState(engine, rawConfig, rawEnv)
    return state
  }

  const plugin: Plugin = {
    name: `${engine.name}/vite`,
    enforce: 'pre',
    async config(config, env) {
      rawConfig = config as Record<string, unknown>
      rawEnv = env
      const nextState = await refreshState()
      if (!nextState)
        return

      return mergeUserConfigs({}, nextState.extraConfig)
    },
    configEnvironment(name, environment) {
      if (environment.consumer !== 'server')
        return

      return {
        define: {
          [`__VITEHUB_ENVIRONMENT_${engine.feature.toUpperCase()}__`]: JSON.stringify(name),
        },
      }
    },
    resolveId(id) {
      if (!state)
        return

      if (id.startsWith('\0') && state.virtualModules.has(id))
        return id

      return state.resolvedIds.get(id)
    },
    load(id) {
      if (!state)
        return

      if (state.virtualModules.has(id))
        return state.virtualModules.get(id)
    },
  }

  return {
    vite: plugin,
  }
}

export function createFeatureVitePlugin<TOptions, TInput, TConfig = TInput>(
  options: FeatureEngine<TOptions, TInput, TConfig> | ViteFeatureFactoryOptions<TOptions, TInput, TConfig>,
): Plugin {
  return createFeatureBridgeBundle(options).vite
}
