import type { NitroModule } from 'nitro/types'
import type { ConfigEnv, Plugin, UserConfig } from 'vite'
import { existsSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { resolve as resolvePath } from 'pathe'
import {
  buildFeatureViteContext,
  createFeatureEngine,
  createFeatureNitroBridge,
  type FeatureEngine,
  type FeatureStateSource,
  type FeatureViteContext,
  type FeatureViteSetupResult,
} from './feature-engine'

export type { FeatureViteContext, FeatureViteSetupResult } from './feature-engine'

export interface FeatureViteState<TConfig> extends FeatureViteContext<TConfig> {
  virtualModules: Map<string, string>
  resolvedIds: Map<string, string>
}

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
  setupNitro?: (nitro: Parameters<NonNullable<NitroModule['setup']>>[0], context: import('./feature-engine').FeatureModuleContext<TConfig>) => void | Promise<void>
}

type ResolvedFeatureViteState<TConfig> = FeatureViteState<TConfig> & {
  extraConfig?: UserConfig
}

type ViteNitroHandler = {
  route: string
  method?: string
  handler: string
}

type ViteNitroConfig = {
  alias?: Record<string, string>
  compatibilityDate?: string
  handlers?: ViteNitroHandler[]
  imports?: Record<string, unknown> | false
  modules?: NitroModule[]
  plugins?: string[]
  preset?: string
  publicAssets?: Array<{
    baseURL?: string
    dir: string
    fallthrough?: boolean
    maxAge?: number
  }>
  runtimeConfig?: Record<string, unknown>
}

type NitroBuilderModule = typeof import('nitro/builder')

function createStateModuleId(feature: string) {
  return `virtual:vitehub/${feature}`
}

function createResolvedVirtualModuleId(feature: string, key: string) {
  return `\0vitehub:${feature}:${key}`
}

function mergeUserConfigs(base: UserConfig, extra?: UserConfig) {
  if (!extra)
    return base

  return {
    ...extra,
    ...base,
    define: {
      ...(extra.define ?? {}),
      ...(base.define ?? {}),
    },
    resolve: {
      ...(extra.resolve ?? {}),
      ...(base.resolve ?? {}),
      alias: {
        ...(typeof extra.resolve?.alias === 'object' && !Array.isArray(extra.resolve.alias) ? extra.resolve.alias : {}),
        ...(typeof base.resolve?.alias === 'object' && !Array.isArray(base.resolve.alias) ? base.resolve.alias : {}),
      },
    },
  } satisfies UserConfig
}

let nitroBuilderPromise: Promise<NitroBuilderModule> | undefined

async function loadNitroBuilder() {
  nitroBuilderPromise ||= import('nitro/builder').catch((error) => {
    throw new Error('[vitehub] Vite projects with `nitro.handlers` require `nitro` to be installed.', {
      cause: error,
    })
  })

  return await nitroBuilderPromise
}

function resolveNitroOptions(
  rootDir: string,
  configKey: string,
  state: ResolvedFeatureViteState<unknown>,
  nitro: ViteNitroConfig | undefined,
  featureNitroModule: NitroModule | undefined,
  dev: boolean,
) {
  const distDir = resolvePath(rootDir, typeof state.extraConfig?.build?.outDir === 'string'
    ? state.extraConfig.build.outDir
    : 'dist')
  const srcDir = existsSync(resolvePath(rootDir, 'src')) ? 'src' : undefined
  const handlers = Array.isArray(nitro?.handlers) ? nitro.handlers : []
  const modules = [
    ...(featureNitroModule ? [featureNitroModule] : []),
    ...((nitro?.modules ?? []).filter(Boolean)),
  ]

  return {
    [configKey]: state.config,
    alias: nitro?.alias,
    compatibilityDate: nitro?.compatibilityDate,
    dev,
    handlers,
    imports: nitro?.imports,
    modules,
    plugins: nitro?.plugins,
    preset: process.env.NITRO_PRESET || nitro?.preset || 'node-server',
    publicAssets: [
      {
        baseURL: '/',
        dir: distDir,
        fallthrough: true,
        maxAge: 0,
      },
      ...(nitro?.publicAssets ?? []).map(asset => ({
        ...asset,
        maxAge: asset.maxAge ?? 0,
      })),
    ],
    rootDir,
    runtimeConfig: {
      ...(nitro?.runtimeConfig ?? {}),
      ...state.runtimeConfig,
    },
    srcDir,
  }
}

function createNitroRouteMatcher(handlers: ViteNitroHandler[]) {
  const entries = handlers.map((handler) => {
    const source = handler.route
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\[\.{3}[^/\\]+\]/g, '.+')
      .replace(/\\\[[^/\\]+\]/g, '[^/]+')
      .replace(/:([^/]+)/g, '[^/]+')

    return {
      method: handler.method?.toUpperCase(),
      pattern: new RegExp(`^${source}/?$`),
    }
  })

  return (method: string, url: string) => {
    const pathname = new URL(url, 'http://vitehub.local').pathname
    return entries.some(entry => (!entry.method || entry.method === method) && entry.pattern.test(pathname))
  }
}

async function copyViteBuildOutputToNitroPublicDir(
  nitro: Awaited<ReturnType<NitroBuilderModule['createNitro']>>,
  rootDir: string,
  outDir: string | undefined,
) {
  const distDir = resolvePath(rootDir, outDir || 'dist')
  if (!existsSync(distDir))
    return

  await mkdir(nitro.options.output.publicDir, { recursive: true })
  await cp(distDir, nitro.options.output.publicDir, {
    force: true,
    recursive: true,
  })
}

async function sendFetchResponse(res: import('node:http').ServerResponse, response: Response) {
  res.statusCode = response.status
  res.statusMessage = response.statusText

  for (const [name, value] of response.headers) {
    res.setHeader(name, value)
  }

  if (!response.body) {
    res.end()
    return
  }

  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>)
      .on('error', reject)
      .pipe(res)
      .on('finish', resolve)
      .on('error', reject)
  })
}

function createStateModuleContents<TConfig>(
  feature: string,
  configKey: string,
  state: FeatureViteContext<TConfig>,
) {
  const payload = {
    feature,
    configKey,
    config: state.config,
    runtimeConfig: state.runtimeConfig,
    hosting: state.hosting,
    rootDir: state.rootDir,
    mode: state.mode,
    command: state.command,
  }

  return [
    `const state = ${JSON.stringify(payload, null, 2)}`,
    'export const feature = state.feature',
    'export const configKey = state.configKey',
    'export const config = state.config',
    'export const runtimeConfig = state.runtimeConfig',
    'export const hosting = state.hosting',
    'export const rootDir = state.rootDir',
    'export const mode = state.mode',
    'export const command = state.command',
    'export default state',
    '',
  ].join('\n')
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

async function resolveFeatureViteState<TOptions, TInput, TConfig>(
  engine: FeatureEngine<TOptions, TInput, TConfig>,
  userConfig: Record<string, unknown>,
  env: ConfigEnv,
): Promise<ResolvedFeatureViteState<TConfig> | undefined> {
  const context = await buildFeatureViteContext(engine, userConfig, env)
  if (!context)
    return undefined

  const setupResult = await engine.setupVite?.(context)
  const modules = new Map<string, string>()
  const resolvedIds = new Map<string, string>()

  const stateModuleId = createStateModuleId(engine.feature)
  modules.set(stateModuleId, createStateModuleContents(engine.feature, engine.configKey, context))
  const resolvedStateModuleId = createResolvedVirtualModuleId(engine.feature, 'state')
  modules.set(resolvedStateModuleId, modules.get(stateModuleId)!)
  resolvedIds.set(stateModuleId, resolvedStateModuleId)

  return {
    ...context,
    virtualModules: modules,
    resolvedIds,
    extraConfig: setupResult && 'config' in setupResult ? setupResult.config : undefined,
  }
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
      const nitroConfig = (rawConfig.nitro || {}) as ViteNitroConfig
      if (!state || !nitroConfig.handlers?.length)
        return

      const nitroBuilder = await loadNitroBuilder()
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
      const matchesNitroRoute = createNitroRouteMatcher(nitroConfig.handlers)

      server.middlewares.use(async (req, res, next) => {
        const method = req.method?.toUpperCase() || 'GET'
        const url = req.url || '/'
        if (!matchesNitroRoute(method, url)) {
          next()
          return
        }

        try {
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

      server.httpServer?.once('close', () => {
        void nitroDevServer?.close()
        void nitroInstance?.close()
      })
    },
    async closeBundle() {
      const nitroConfig = (rawConfig.nitro || {}) as ViteNitroConfig
      if (!state || !nitroConfig.handlers?.length || rawEnv.command !== 'build')
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
