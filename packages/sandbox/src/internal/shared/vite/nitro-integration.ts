import { existsSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { resolve as resolvePath } from 'pathe'

import type { NitroModule } from 'nitro/types'

import type { ResolvedFeatureViteState } from './virtual-modules'

export type ViteNitroHandler = {
  route: string
  method?: string
  handler: string
}

export type ViteNitroConfig = {
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

export type NitroBuilderModule = typeof import('nitro/builder')

let nitroBuilderPromise: Promise<NitroBuilderModule> | undefined

export async function loadNitroBuilder() {
  nitroBuilderPromise ||= import('nitro/builder').catch((error) => {
    throw new Error('[vitehub] Vite projects with `nitro.handlers` require `nitro` to be installed.', {
      cause: error,
    })
  })

  return await nitroBuilderPromise
}

export function mergeRuntimeConfig(
  stateRuntimeConfig: Record<string, unknown>,
  nitroRuntimeConfig: Record<string, unknown> | undefined,
  configKey: string,
) {
  const stateFeatureConfig = stateRuntimeConfig[configKey]
  const nitroFeatureConfig = nitroRuntimeConfig?.[configKey]

  return {
    ...stateRuntimeConfig,
    ...nitroRuntimeConfig,
    ...(stateFeatureConfig
      && typeof stateFeatureConfig === 'object'
      && !Array.isArray(stateFeatureConfig)
      && nitroFeatureConfig
      && typeof nitroFeatureConfig === 'object'
      && !Array.isArray(nitroFeatureConfig)
      ? {
          [configKey]: {
            ...stateFeatureConfig,
            ...nitroFeatureConfig,
          },
        }
      : {}),
  }
}

export function resolveNitroOptions(
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
    runtimeConfig: mergeRuntimeConfig(state.runtimeConfig, nitro?.runtimeConfig, configKey),
    srcDir,
  }
}

export function isFeatureDefinitionChange(feature: string, file: string) {
  if (feature === 'sandbox')
    return /\.sandbox\.[cm]?[jt]s$/i.test(file)

  return false
}

export function createNitroRouteMatcher(handlers: ViteNitroHandler[]) {
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

export async function copyViteBuildOutputToNitroPublicDir(
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

export async function sendFetchResponse(res: import('node:http').ServerResponse, response: Response) {
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
