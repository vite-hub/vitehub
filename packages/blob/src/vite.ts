import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { getViteMode } from "@vite-hub/internal/build/mode"
import { composeNitroCloudflareProviderOutput, registerCloudflareProviderOutput, resetComposedProviderOutput, shouldSkipViteProviderBuild, useComposedProviderOutput } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalMerger, isServerEnvironment, resolveNitroVercelFunctionName } from "@vite-hub/internal/build/vite"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { resolve } from "pathe"

import { createCloudflareR2Bindings, generateProviderOutputs, prepareProviderOutputs, blobPackageName } from "./internal/vite-build.ts"
import { createBlobCloudflareProvisionStep, createBlobVercelProvisionStep } from "./provision.ts"
import {
  BLOB_VIRTUAL_CONFIG_ID,
  BLOB_VITE_PLUGIN_NAME,
  resolveBlobViteConfig,
} from "./vite-config.ts"

import type { BlobViteRuntimeConfig } from "./vite-config.ts"
import type { BlobModuleOptions, BlobServeConfig } from "./types.ts"
import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ComposedProviderOutput } from "@vite-hub/internal/build/deployment-output"
import type { Plugin, ResolvedConfig } from "vite"

const RESOLVED_BLOB_VIRTUAL_CONFIG_ID = `\0${BLOB_VIRTUAL_CONFIG_ID}`
const generatedNitroBlobPlugin = ".vitehub/nitro/blob/plugin.ts"
const generatedBlobServeRouteHandler = ".vitehub/blob/serve-route.ts"

export { BLOB_VIRTUAL_CONFIG_ID, BLOB_VITE_PLUGIN_NAME, resolveBlobViteConfig }
export type { BlobViteRuntimeConfig } from "./vite-config.ts"

export interface BlobVitePluginAPI {
  getConfig: () => BlobViteRuntimeConfig
}

interface BlobProvisionContributingPlugin {
  vitehub?: { cli?: () => Promise<ViteHubCliContributor> }
}

export type BlobVitePlugin = Plugin & BlobProvisionContributingPlugin & { api: BlobVitePluginAPI }

type InternalBlobModuleOptions = BlobModuleOptions & {
  importBase?: string
}

const mergeNoExternal = createNoExternalMerger(blobPackageName)

function serializeVirtualConfig(config: BlobViteRuntimeConfig): string {
  return [
    `export const hosting = ${JSON.stringify(config.hosting)};`,
    `export const blob = ${JSON.stringify(config.blob)};`,
    "export default { hosting, blob };",
  ].join("\n")
}

function cloneNitroConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}

function isNitroCloudflareHost(value: unknown): boolean {
  const nitro = cloneNitroConfig(value)
  const preset = typeof nitro.preset === "string" ? nitro.preset : process.env.NITRO_PRESET || process.env.SERVER_PRESET
  return getHostingProvider(preset) === "cloudflare" || Object.hasOwn(nitro, "cloudflare")
}

function mergeNitroCloudflareBlobOutput(config: object, nitro: Record<string, unknown>, blob: BlobModuleOptions | undefined, cloudflareOwnedByNitro: boolean): Record<string, unknown> {
  const bindings = cloudflareOwnedByNitro
    ? createCloudflareR2Bindings(resolveBlobViteConfig(blob, { hosting: "cloudflare" }).blob)
    : undefined
  registerCloudflareProviderOutput(config, "blob", bindings ? { r2Buckets: bindings } : {})
  return bindings ? composeNitroCloudflareProviderOutput(config, nitro) : nitro
}

function normalizeNitroRoute(route: string): string {
  return (route.startsWith("/") ? route : `/${route}`).replace(/\[([^\]]+)\]/g, ":$1")
}

function blobServeNitroRoute(serve: BlobServeConfig): string {
  return `${normalizeNitroRoute(serve.route).replace(/\/+$/, "")}/**`
}

function mergeNitroBlobConfig(value: unknown, serve?: BlobServeConfig): Record<string, unknown> {
  const nitro = cloneNitroConfig(value)
  const plugins = Array.isArray(nitro.plugins) ? [...nitro.plugins] : []
  if (!plugins.includes(generatedNitroBlobPlugin)) plugins.push(generatedNitroBlobPlugin)
  if (!serve) return { ...nitro, plugins }
  const existingHandlers = Array.isArray(nitro.handlers) ? nitro.handlers : []
  return {
    ...nitro,
    handlers: [
      ...existingHandlers,
      { handler: generatedBlobServeRouteHandler, route: blobServeNitroRoute(serve) },
    ],
    plugins,
  }
}

function renderNitroBlobPlugin(blob: BlobViteRuntimeConfig["blob"], importBase = blobPackageName): string {
  return [
    `import { setBlobRuntimeConfig } from '${importBase}/runtime/state'`,
    "",
    `const blobConfig = ${JSON.stringify(blob)}`,
    "",
    "export default function vitehubBlobPlugin() {",
    "  setBlobRuntimeConfig(blobConfig)",
    "}",
    "",
  ].join("\n")
}

function renderBlobServeRouteHandler(serve: BlobServeConfig, importBase = blobPackageName): string {
  return [
    `import { blob } from '${importBase}'`,
    "import { createError, defineEventHandler, getRouterParam } from 'h3'",
    "",
    `const storeName = ${JSON.stringify(serve.store)}`,
    "",
    "export default defineEventHandler(async (event) => {",
    "  const pathname = getRouterParam(event, '_', { decode: false }) || ''",
    "  if (!pathname) throw createError({ statusCode: 404, statusMessage: 'Blob not found' })",
    "  return await blob.store(storeName).serve(event, pathname)",
    "})",
    "",
  ].join("\n")
}

async function refreshBlobGeneratedFiles(root: string, blob: BlobViteRuntimeConfig["blob"], importBase = blobPackageName): Promise<void> {
  await writeFileIfChanged(resolve(root, generatedNitroBlobPlugin), renderNitroBlobPlugin(blob, importBase))
  const serve = blob ? blob.serve : undefined
  if (!serve) return
  const file = resolve(root, generatedBlobServeRouteHandler)
  await writeFileIfChanged(file, renderBlobServeRouteHandler(serve, importBase))
}

export function hubBlob(options?: BlobModuleOptions): BlobVitePlugin {
  const importBase = (options as InternalBlobModuleOptions | undefined)?.importBase ?? blobPackageName
  let blob: BlobModuleOptions | undefined = options
  let clientOutDir = "dist"
  let command: "build" | "serve" = "serve"
  let cloudflareOwnedByNitro = false
  let providerArtifacts: Awaited<ReturnType<typeof prepareProviderOutputs>> | undefined
  let providerOutput: ComposedProviderOutput | undefined
  let rootDir = process.cwd()
  let runtimeConfig: BlobViteRuntimeConfig | undefined
  let resolved: ResolvedConfig | undefined
  const getConfig = () => runtimeConfig ??= resolveBlobViteConfig(options)

  return {
    name: BLOB_VITE_PLUGIN_NAME,
    api: { getConfig },
    vitehub: {
      cli: async () => {
        return {
          namespaces: [],
          provision: [createBlobCloudflareProvisionStep(() => blob), createBlobVercelProvisionStep(() => blob)],
        }
      },
    },
    config(config, env) {
      command = env.command
      blob = config.blob ?? blob
      const blobConfig = resolveBlobViteConfig(blob)
      const configuredNitro = (config as { nitro?: unknown }).nitro
      cloudflareOwnedByNitro = isNitroCloudflareHost(configuredNitro)
      const nitro = mergeNitroBlobConfig(
        configuredNitro,
        blobConfig.blob ? blobConfig.blob.serve : undefined,
      )
      const composedNitro = mergeNitroCloudflareBlobOutput(config, nitro, blob, cloudflareOwnedByNitro)
      ;(config as { nitro?: unknown }).nitro = composedNitro
      return { nitro: composedNitro } as never
    },
    async configResolved(config) {
      resolved = config
      clientOutDir = config.build.outDir
      rootDir = config.root
      blob = config.blob ?? blob
      const configuredNitro = (config as { nitro?: unknown }).nitro
      cloudflareOwnedByNitro ||= isNitroCloudflareHost(configuredNitro)
      ;(config as { nitro?: unknown }).nitro = mergeNitroCloudflareBlobOutput(config, cloneNitroConfig(configuredNitro), blob, cloudflareOwnedByNitro)
      providerOutput = useComposedProviderOutput(config)
      runtimeConfig = resolveBlobViteConfig(blob)
      await refreshBlobGeneratedFiles(config.root, runtimeConfig.blob, importBase)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }

      return {
        resolve: {
          noExternal: mergeNoExternal(config.resolve?.noExternal),
        },
      }
    },
    buildStart() {
      resetComposedProviderOutput(providerOutput)
    },
    async buildEnd() {
      if (shouldSkipViteProviderBuild(command, getViteMode())) {
        return
      }

      providerArtifacts = await prepareProviderOutputs({
        blob,
        providerOutput,
        rootDir,
      })
    },
    async closeBundle() {
      if (shouldSkipViteProviderBuild(command, getViteMode())) {
        return
      }

      await generateProviderOutputs({
        blob,
        clientOutDir,
        cloudflareOwnedByNitro,
        artifacts: providerArtifacts,
        providerOutput,
        rootDir,
        serverFunctionName: resolveNitroVercelFunctionName(resolved ?? {}, "blob"),
      })
    },
    load(id) {
      if (id === RESOLVED_BLOB_VIRTUAL_CONFIG_ID) {
        return serializeVirtualConfig(getConfig())
      }
    },
    resolveId(id) {
      if (id === BLOB_VIRTUAL_CONFIG_ID) {
        return RESOLVED_BLOB_VIRTUAL_CONFIG_ID
      }
    },
  }
}

declare module "vite" {
  interface UserConfig {
    blob?: BlobModuleOptions
  }
}
