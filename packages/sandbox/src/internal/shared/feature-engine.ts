import { readPackageJSON } from 'pkg-types'
import { resolve as resolveFs } from 'pathe'
import type { Nitro, NitroModule } from 'nitro/types'
import type { ConfigEnv, UserConfig } from 'vite'
import { detectHosting } from './hosting'
import { normalizeFeatureOptions } from './feature-options'

export interface FeatureResolvedState<TConfig> {
  rootDir: string
  config: TConfig
  deps: Record<string, string>
  runtimeConfig: Record<string, unknown>
  hosting?: string
}

export interface FeatureViteContext<TConfig> extends FeatureResolvedState<TConfig> {
  command: ConfigEnv['command']
  mode: string
}

export type FeatureModuleContext<TConfig> = FeatureResolvedState<TConfig>

export interface FeatureViteSetupResult {
  config?: UserConfig
}

export type FeatureStateSource<_TOptions> =
  | {
    kind: 'vite'
    userConfig: Record<string, unknown>
    env: ConfigEnv
  }
  | {
    kind: 'nitro'
    nitro: Nitro
  }

export interface FeatureEngine<TOptions, TInput, TConfig = TInput> {
  name: string
  feature: string
  configKey: string
  defaultOptions?: TOptions | (() => TOptions)
  loadDeps?: boolean
  normalizeOptions: (options: TOptions | undefined) => TInput | undefined
  resolveConfig?: (config: TInput, hosting?: string) => TConfig
  assignRuntimeConfig?: (runtimeConfig: Record<string, unknown>, config: TConfig) => void
  readPublicOptions: (source: FeatureStateSource<TOptions>) => TOptions | undefined
  setupVite?: (context: FeatureViteContext<TConfig>) => Promise<FeatureViteSetupResult | void> | FeatureViteSetupResult | void
  setupNitro?: (nitro: Nitro, context: FeatureModuleContext<TConfig>) => void | Promise<void>
}

export function createFeatureEngine<TOptions, TInput, TConfig = TInput>(
  options: FeatureEngine<TOptions, TInput, TConfig>,
) {
  return options
}

export function normalizeFeaturePublicOptions<TOptions extends object>(
  feature: string,
  options: TOptions | false | undefined,
): TOptions | undefined {
  return normalizeFeatureOptions(feature, options)
}

export function readFeaturePublicOptions<TOptions>(
  source: FeatureStateSource<TOptions>,
  key: string,
): TOptions | undefined {
  if (source.kind === 'vite')
    return source.userConfig[key] as TOptions | undefined

  return (source.nitro.options as typeof source.nitro.options & Record<string, TOptions | undefined>)[key]
}

export function resolveDefaultOptions<TOptions>(defaultOptions: TOptions | (() => TOptions)) {
  return typeof defaultOptions === 'function'
    ? (defaultOptions as () => TOptions)()
    : defaultOptions
}

export function applyRuntimeConfig<TConfig>(runtimeConfig: Record<string, unknown>, key: string, config: TConfig) {
  runtimeConfig[key] = config
}

export async function readWorkspaceDeps(rootDir: string) {
  const packageJson = await readPackageJSON(rootDir)
  return {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }
}

export function resolveViteRoot(config: Record<string, unknown>) {
  return resolveFs(process.cwd(), typeof config.root === 'string' ? config.root : '.')
}

function resolveRawOptions<TOptions, TInput, TConfig>(
  engine: FeatureEngine<TOptions, TInput, TConfig>,
  source: FeatureStateSource<TOptions>,
) {
  const rawOptions = engine.readPublicOptions(source)
  return typeof rawOptions === 'undefined' && typeof engine.defaultOptions !== 'undefined'
    ? resolveDefaultOptions(engine.defaultOptions)
    : rawOptions
}

function resolveNormalizedConfig<TOptions, TInput, TConfig>(
  engine: FeatureEngine<TOptions, TInput, TConfig>,
  source: FeatureStateSource<TOptions>,
) {
  const normalizedOptions = engine.normalizeOptions(resolveRawOptions(engine, source))
  if (!normalizedOptions)
    return undefined

  const hosting = source.kind === 'vite'
    ? detectHosting({ options: source.userConfig as { nitro?: { preset?: string | null }, preset?: string | null } })
    : detectHosting(source.nitro)
  const config = engine.resolveConfig
    ? engine.resolveConfig(normalizedOptions, hosting)
    : normalizedOptions as unknown as TConfig

  return {
    config,
    hosting: hosting || undefined,
  }
}

export async function buildFeatureResolvedState<TOptions, TInput, TConfig>(
  engine: FeatureEngine<TOptions, TInput, TConfig>,
  source: FeatureStateSource<TOptions>,
): Promise<FeatureResolvedState<TConfig> | undefined> {
  const resolved = resolveNormalizedConfig(engine, source)
  if (!resolved)
    return undefined

  const rootDir = source.kind === 'vite'
    ? resolveViteRoot(source.userConfig)
    : source.nitro.options.rootDir
  const runtimeConfig: Record<string, unknown> = source.kind === 'nitro'
    ? ((source.nitro.options as typeof source.nitro.options & { runtimeConfig?: Record<string, unknown> }).runtimeConfig ||= {})
    : {}

  if (resolved.hosting)
    runtimeConfig.hosting ||= resolved.hosting

  if (engine.assignRuntimeConfig)
    engine.assignRuntimeConfig(runtimeConfig, resolved.config)
  else
    applyRuntimeConfig(runtimeConfig, engine.configKey, resolved.config)

  const deps = engine.loadDeps ? await readWorkspaceDeps(rootDir) : {}

  return {
    rootDir,
    config: resolved.config,
    deps,
    runtimeConfig,
    hosting: resolved.hosting,
  }
}

export async function buildFeatureViteContext<TOptions, TInput, TConfig>(
  engine: FeatureEngine<TOptions, TInput, TConfig>,
  userConfig: Record<string, unknown>,
  env: ConfigEnv,
): Promise<FeatureViteContext<TConfig> | undefined> {
  const state = await buildFeatureResolvedState(engine, {
    kind: 'vite',
    userConfig,
    env,
  })
  if (!state)
    return undefined

  return {
    ...state,
    command: env.command,
    mode: env.mode,
  }
}

export async function buildFeatureNitroContext<TOptions, TInput, TConfig>(
  engine: FeatureEngine<TOptions, TInput, TConfig>,
  nitro: Nitro,
): Promise<FeatureModuleContext<TConfig> | undefined> {
  return await buildFeatureResolvedState(engine, {
    kind: 'nitro',
    nitro,
  })
}

export function createFeatureNitroBridge<TOptions, TInput, TConfig>(
  engine: FeatureEngine<TOptions, TInput, TConfig>,
): NitroModule {
  return {
    name: engine.name,
    async setup(nitro) {
      const context = await buildFeatureNitroContext(engine, nitro)
      if (!context)
        return

      await engine.setupNitro?.(nitro, context)
    },
  }
}
