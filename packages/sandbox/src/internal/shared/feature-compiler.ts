import type { Nitro } from 'nitro/types'
import type { FeatureRuntimePlan } from './runtime-artifacts'
import { resolveNitroScanRoots } from './feature-definitions'
import { detectHosting } from './hosting'
import { ensureNitroImports } from './nitro-imports'
import { applyFeaturePlanToNitro } from './runtime-artifacts'

export interface FeatureCompilerContext<TConfig> {
  nitro: Nitro
  config: TConfig
  deps: Record<string, string>
  runtimeConfig: Record<string, unknown>
  hosting?: string
  scanRoots: string[]
}

export interface FeatureCompiler<TConfig> {
  feature: string
  compile: (context: FeatureCompilerContext<TConfig>) => Promise<FeatureRuntimePlan> | FeatureRuntimePlan
}

export async function compileFeatureIntoNitro<TConfig>(
  nitro: Nitro,
  config: TConfig | undefined,
  deps: Record<string, string>,
  compiler: FeatureCompiler<TConfig>,
) {
  if (!config)
    return false

  const nitroOptions = nitro.options as typeof nitro.options & { runtimeConfig?: Record<string, unknown> }
  nitroOptions.runtimeConfig ||= {}
  ensureNitroImports(nitro)

  const plan = await compiler.compile({
    nitro,
    config,
    deps,
    runtimeConfig: nitroOptions.runtimeConfig,
    hosting: typeof nitroOptions.runtimeConfig.hosting === 'string'
      ? nitroOptions.runtimeConfig.hosting
      : detectHosting(nitro),
    scanRoots: resolveNitroScanRoots(nitro),
  })
  await applyFeaturePlanToNitro(nitro, plan)
  return true
}
