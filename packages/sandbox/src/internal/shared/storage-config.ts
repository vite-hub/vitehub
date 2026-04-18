import { cloneFeatureOptions } from './feature-options'
import { normalizeHosting } from './hosting'
import { readNonEmptyEnv } from './env'

export interface StorageEnv {
  [key: string]: string | undefined
}

export type StorageConfigSource = 'explicit' | 'env' | 'hosting' | 'fallback'

export interface StorageConfigContext {
  env: StorageEnv
  hosting: string
}

export interface StorageConfigResult<TConfig> {
  config: TConfig
  source: StorageConfigSource
}

export interface StorageConfigInput {
  env?: StorageEnv
  hosting?: string | null
}

export interface StorageConfigResolver<TOptions extends object, TConfig> {
  source: StorageConfigSource
  resolve: (options: TOptions, context: StorageConfigContext) => TConfig | undefined
}

export function normalizeStorageConfigInput(input?: string | StorageConfigInput): StorageConfigContext {
  if (typeof input === 'string') {
    return {
      env: process.env,
      hosting: normalizeHosting(input),
    }
  }

  return {
    env: input?.env || process.env,
    hosting: normalizeHosting(input?.hosting),
  }
}

export function normalizeStorageOptions<TOptions extends object>(options: TOptions | false | undefined): TOptions | undefined {
  if (options === false || typeof options === 'undefined')
    return undefined

  if ((options as unknown) === true)
    return {} as TOptions

  return cloneFeatureOptions('storage config', options)
}

export const readStorageEnv = readNonEmptyEnv

export function resolveStorageConfig<TOptions extends object, TConfig>(
  options: TOptions | false | undefined,
  input: string | StorageConfigInput | undefined,
  candidates: StorageConfigResolver<TOptions, TConfig>[],
): StorageConfigResult<TConfig> | undefined {
  const normalizedOptions = normalizeStorageOptions(options)
  if (!normalizedOptions)
    return undefined

  const context = normalizeStorageConfigInput(input)

  for (const candidate of candidates) {
    const config = candidate.resolve(normalizedOptions, context)
    if (typeof config !== 'undefined') {
      return {
        config,
        source: candidate.source,
      }
    }
  }
}
