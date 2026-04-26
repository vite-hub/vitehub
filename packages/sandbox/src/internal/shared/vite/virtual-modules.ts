import {
  buildFeatureViteContext,
  type FeatureEngine,
  type FeatureViteContext,
} from '../feature-engine'

import type { ConfigEnv, UserConfig } from 'vite'

export interface FeatureViteState<TConfig> extends FeatureViteContext<TConfig> {
  virtualModules: Map<string, string>
  resolvedIds: Map<string, string>
}

export type ResolvedFeatureViteState<TConfig> = FeatureViteState<TConfig> & {
  extraConfig?: UserConfig
}

export function createStateModuleId(feature: string) {
  return `virtual:vitehub/${feature}`
}

export function createResolvedVirtualModuleId(feature: string, key: string) {
  return `\0vitehub:${feature}:${key}`
}

export function createStateModuleContents<TConfig>(
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

export async function resolveFeatureViteState<TOptions, TInput, TConfig>(
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
