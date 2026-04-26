import {
  createFeatureEngine,
  createFeatureNitroBridge,
  type FeatureEngine,
  type FeatureModuleContext,
  type FeatureStateSource,
  type FeatureViteContext,
  type FeatureViteSetupResult,
} from './feature-engine'
import { mergeUserConfigs } from './vite/config-merge'
import {
  createNitroRouteMatcher,
  copyViteBuildOutputToNitroPublicDir,
  isFeatureDefinitionChange,
  loadNitroBuilder,
  resolveNitroOptions,
  sendFetchResponse,
  type NitroBuilderModule,
  type ViteNitroConfig,
} from './vite/nitro-integration'
import { resolveFeatureViteState, type ResolvedFeatureViteState } from './vite/virtual-modules'

import type { NitroModule } from 'nitro/types'
import type { ConfigEnv, Plugin } from 'vite'

export type { FeatureViteContext, FeatureViteSetupResult } from './feature-engine'
export type { FeatureViteState } from './vite/virtual-modules'

export interface FeatureBridgeBundle {
  vite: Plugin
  nitro?: NitroModule
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
  setupNitro?: (nitro: Parameters<NonNullable<NitroModule['setup']>>[0], context: FeatureModuleContext<TConfig>) => void | Promise<void>
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
      if (source.kind !== 'vite')
        throw new TypeError(`[vitehub] ${options.name} Vite engine cannot read non-Vite options.`)
      return options.readOptions(source.userConfig, source.env)
    },
    setupVite: options.setup,
    setupNitro: options.setupNitro,
  })
}

export function createFeatureBridgeBundle<TOptions, TInput, TConfig = TInput>(
  options: FeatureEngine<TOptions, TInput, TConfig> | ViteFeatureFactoryOptions<TOptions, TInput, TConfig>,
): FeatureBridgeBundle {
  const engine = normalizeViteEngine(options)
  let state: ResolvedFeatureViteState<TConfig> | undefined
  let rawConfig: Record<string, unknown> = {}
  let rawEnv: ConfigEnv = { command: 'serve', mode: 'development' }
  let nitroDevServer: Awaited<ReturnType<NitroBuilderModule['createDevServer']>> | undefined
  let nitroInstance: Awaited<ReturnType<NitroBuilderModule['createNitro']>> | undefined

  async function refreshState() {
    state = await resolveFeatureViteState(engine, rawConfig, rawEnv)
    return state
  }

  const plugin: Plugin & { nitro?: NitroModule } = {
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
    async configureServer(server) {
      const nitroConfig = rawConfig.nitro as ViteNitroConfig | undefined
      if (!state || !nitroConfig?.handlers?.length)
        return

      const nitroBuilder = await loadNitroBuilder()
      let rebuildPromise: Promise<void> | undefined
      async function closeNitroDevServer() {
        await nitroDevServer?.close()
        await nitroInstance?.close()
        nitroDevServer = undefined
        nitroInstance = undefined
      }
      async function rebuildNitroDevServer() {
        if (!state)
          return

        await closeNitroDevServer()
        nitroInstance = await nitroBuilder.createNitro(resolveNitroOptions(
          state.rootDir,
          engine.configKey,
          state as ResolvedFeatureViteState<unknown>,
          nitroConfig,
          plugin.nitro,
          true,
        ) as Parameters<typeof nitroBuilder.createNitro>[0])
        await nitroBuilder.prepare(nitroInstance)
        nitroDevServer = nitroBuilder.createDevServer(nitroInstance)
        await nitroBuilder.build(nitroInstance)
      }
      function scheduleNitroRebuild(file: string) {
        if (!isFeatureDefinitionChange(engine.feature, file))
          return

        rebuildPromise ||= rebuildNitroDevServer()
          .catch(error => server.config.logger.error(error))
          .finally(() => {
            rebuildPromise = undefined
          })
      }

      await rebuildNitroDevServer()
      const matchesNitroRoute = createNitroRouteMatcher(nitroConfig.handlers)

      server.middlewares.use(async (req, res, next) => {
        const method = req.method?.toUpperCase() || 'GET'
        const url = req.url || '/'
        if (!matchesNitroRoute(method, url)) {
          next()
          return
        }

        try {
          if (rebuildPromise)
            await rebuildPromise
          if (!nitroDevServer)
            throw new Error('[vitehub] Nitro dev server is not ready.')

          const request = new Request(new URL(url, 'http://vitehub.local'), {
            method,
            headers: new Headers(req.headers as Record<string, string>),
            body: method === 'GET' || method === 'HEAD' ? undefined : req as never,
            duplex: method === 'GET' || method === 'HEAD' ? undefined : 'half',
          })
          const response = await nitroDevServer!.fetch(request)
          await sendFetchResponse(res, response)
        }
        catch (error) {
          next(error as Error)
        }
      })

      server.watcher.on('add', scheduleNitroRebuild)
      server.watcher.on('change', scheduleNitroRebuild)
      server.watcher.on('unlink', scheduleNitroRebuild)
      server.httpServer?.once('close', () => {
        server.watcher.off('add', scheduleNitroRebuild)
        server.watcher.off('change', scheduleNitroRebuild)
        server.watcher.off('unlink', scheduleNitroRebuild)
        void closeNitroDevServer()
      })
    },
    async closeBundle() {
      const nitroConfig = rawConfig.nitro as ViteNitroConfig | undefined
      if (!state || !nitroConfig?.handlers?.length || rawEnv.command !== 'build')
        return

      const nitroBuilder = await loadNitroBuilder()
      const nitro = await nitroBuilder.createNitro(resolveNitroOptions(
        state.rootDir,
        engine.configKey,
        state as ResolvedFeatureViteState<unknown>,
        nitroConfig,
        plugin.nitro,
        false,
      ) as Parameters<typeof nitroBuilder.createNitro>[0])

      try {
        await nitroBuilder.prepare(nitro)
        await nitroBuilder.copyPublicAssets(nitro)
        await nitroBuilder.prerender(nitro)
        await nitroBuilder.build(nitro)
        await copyViteBuildOutputToNitroPublicDir(
          nitro,
          state.rootDir,
          typeof state.extraConfig?.build?.outDir === 'string' ? state.extraConfig.build.outDir : undefined,
        )
      }
      finally {
        await nitro.close()
      }
    },
  }

  if (engine.setupNitro)
    plugin.nitro = createFeatureNitroBridge(engine)

  return {
    vite: plugin,
    nitro: plugin.nitro,
  }
}

export function createFeatureVitePlugin<TOptions, TInput, TConfig = TInput>(
  options: FeatureEngine<TOptions, TInput, TConfig> | ViteFeatureFactoryOptions<TOptions, TInput, TConfig>,
): Plugin {
  return createFeatureBridgeBundle(options).vite
}

export function createFeatureNitroModule<TOptions, TInput, TConfig = TInput>(
  options: FeatureEngine<TOptions, TInput, TConfig> | ViteFeatureFactoryOptions<TOptions, TInput, TConfig>,
): NitroModule {
  const nitro = createFeatureBridgeBundle(options).nitro
  if (!nitro) {
    throw new TypeError('[vitehub] Feature bridge does not expose a Nitro module.')
  }
  return nitro
}
