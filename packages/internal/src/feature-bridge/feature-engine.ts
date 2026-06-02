import { readFile } from 'node:fs/promises'
import { resolve as resolveFs } from 'pathe'
import { detectHosting } from './hosting.ts'
import { normalizeFeatureOptions } from './feature-options.ts'

export interface FeatureConfigEnvLike {
  command: 'build' | 'serve'
  mode: string
}

export interface FeatureUserConfigLike {
  build?: {
    outDir?: string
  }
  define?: Record<string, unknown>
  resolve?: {
    alias?: Record<string, string>
  }
  [key: string]: unknown
}

export interface FeatureResolvedState<TConfig> {
  rootDir: string
  config: TConfig
  deps: Record<string, string>
  runtimeConfig: Record<string, unknown>
  hosting?: string
}

export interface FeatureViteContext<TConfig> extends FeatureResolvedState<TConfig> {
  command: FeatureConfigEnvLike['command']
  mode: string
}

export type FeatureModuleContext<TConfig> = FeatureResolvedState<TConfig>

export interface FeatureViteSetupResult {
  config?: FeatureUserConfigLike
}

export type FeatureStateSource<_TOptions> =
  {
    kind: 'vite'
    userConfig: Record<string, unknown>
    env: FeatureConfigEnvLike
  }

export interface FeatureEngine<TOptions, TInput, TConfig = TInput> {
  name: string
  feature: string
  configKey: string
  defaultOptions?: TOptions | (() => TOptions)
  loadDeps?: boolean
  normalizeOptions: (options: TOptions | false | undefined) => TInput | undefined
  resolveConfig?: (config: TInput, hosting?: string) => TConfig
  assignRuntimeConfig?: (runtimeConfig: Record<string, unknown>, config: TConfig) => void
  readPublicOptions: (source: FeatureStateSource<TOptions>) => TOptions | false | undefined
  setupVite?: (context: FeatureViteContext<TConfig>) => Promise<FeatureViteSetupResult | void> | FeatureViteSetupResult | void
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
  return source.userConfig[key] as TOptions | undefined
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
  const packageJson = JSON.parse(await readFile(resolveFs(rootDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
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
  const rawOptions = resolveRawOptions(engine, source)
  const hosting = detectHosting({ options: source.userConfig as { preset?: string | null } })

  if (rawOptions === false) {
    return {
      config: false as TConfig,
      hosting: hosting || undefined,
    }
  }

  const normalizedOptions = engine.normalizeOptions(rawOptions)
  if (!normalizedOptions)
    return undefined

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

  const rootDir = resolveViteRoot(source.userConfig)
  const runtimeConfig: Record<string, unknown> = {}

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
  env: FeatureConfigEnvLike,
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
