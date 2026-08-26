import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { getViteMode } from "@vite-hub/internal/build/mode"
import { composeNitroCloudflareProviderOutput, contributeCloudflareProviderOutput, contributeProviderDeploymentOutput, finalizeProviderDeploymentOutputs, resetProviderDeploymentOutputs, resetProviderOutputRuntime, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalMerger, hasNitroConfigContext, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { resolve } from "pathe"

import { createCloudflareR2Bindings, generateProviderOutputs, prepareProviderOutputs, renderBlobRuntimeModule, blobPackageName } from "./internal/vite-build.ts"
import { createBlobCloudflareProvisionStep, createBlobVercelProvisionStep } from "./provision.ts"
import {
  BLOB_VIRTUAL_CONFIG_ID,
  BLOB_VITE_PLUGIN_NAME,
  resolveBlobViteConfig,
} from "./vite-config.ts"

import type { BlobViteRuntimeConfig } from "./vite-config.ts"
import type { BlobModuleOptions, BlobServeConfig } from "./types.ts"
import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { Plugin, ResolvedConfig } from "vite"

const RESOLVED_BLOB_VIRTUAL_CONFIG_ID = `\0${BLOB_VIRTUAL_CONFIG_ID}`
const generatedNitroBlobPlugin = ".vitehub/nitro/blob/plugin.ts"
const generatedNitroBlobRuntime = ".vitehub/nitro/blob/runtime.mjs"
const generatedNitroBlobMiddleware = ".vitehub/nitro/blob/middleware.ts"
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

interface InternalBlobModuleOptions {
  importBase?: string
  nitroOwned?: boolean
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

function hasNitroVitePluginOption(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasNitroVitePluginOption)
  return Boolean(value)
    && typeof value === "object"
    && hasNitroConfigContext({ plugins: [value as { name: string }] })
}

function mergeNitroExternal(value: unknown, addition: string): unknown {
  if (typeof value === "undefined") return [addition]
  if (Array.isArray(value)) return value.includes(addition) ? [...value] : [...value, addition]
  if (typeof value === "string" || value instanceof RegExp) return [value, addition]
  if (typeof value === "function") {
    return (source: string, importer?: string, isResolved?: boolean) => source === addition || Boolean(value(source, importer, isResolved))
  }
  return value
}

function getNitroHostingProvider(value: unknown): ReturnType<typeof getHostingProvider> {
  const nitro = cloneNitroConfig(value)
  const preset = typeof nitro.preset === "string" ? nitro.preset : process.env.NITRO_PRESET || process.env.SERVER_PRESET || process.env.VITEHUB_HOSTING
  return typeof preset === "string" ? getHostingProvider(preset) : undefined
}

function isNitroCloudflareHost(value: unknown): boolean {
  return getNitroHostingProvider(value) === "cloudflare"
}

function mergeNitroCloudflareBlobOutput(config: object, nitro: Record<string, unknown>, blob: BlobModuleOptions | undefined, cloudflareOwnedByNitro: boolean): Record<string, unknown> {
  const providerOutput = useProviderOutputCatalog(config)
  if (!cloudflareOwnedByNitro) {
    contributeCloudflareProviderOutput(providerOutput, { owner: "blob" })
    return composeNitroCloudflareProviderOutput(providerOutput, nitro)
  }
  const bindings = createCloudflareR2Bindings(resolveBlobViteConfig(blob, { hosting: "cloudflare" }).blob)
  const cloudflare = cloneNitroConfig(nitro.cloudflare)
  const wrangler = cloneNitroConfig(cloudflare.wrangler)
  const compatibilityFlags = Array.isArray(wrangler.compatibility_flags) ? [...wrangler.compatibility_flags] : []
  if (!compatibilityFlags.includes("nodejs_compat")) compatibilityFlags.push("nodejs_compat")
  const rollupConfig = cloneNitroConfig(nitro.rollupConfig)
  const baseNitro = {
    ...nitro,
    cloudflare: { ...cloudflare, wrangler: { ...wrangler, compatibility_flags: compatibilityFlags } },
    rollupConfig: { ...rollupConfig, external: mergeNitroExternal(rollupConfig.external, "cloudflare:workers") },
  }
  contributeCloudflareProviderOutput(providerOutput, { owner: "blob", ...(bindings ? { r2Buckets: bindings } : {}) })
  return composeNitroCloudflareProviderOutput(providerOutput, baseNitro, nitro)
}

function normalizeNitroRoute(route: string): string {
  return (route.startsWith("/") ? route : `/${route}`).replace(/\[([^\]]+)\]/g, ":$1")
}

function blobServeNitroRoute(serve: BlobServeConfig): string {
  return `${normalizeNitroRoute(serve.route).replace(/\/+$/, "")}/**`
}

function isGeneratedNitroRegistration(value: unknown, generatedPath: string): boolean {
  return typeof value === "string"
    && (value === generatedPath || value.replaceAll("\\", "/").endsWith(`/${generatedPath}`))
}

function mergeNitroBlobConfig(value: unknown, serve: BlobServeConfig | undefined, cloudflare: boolean, root?: string): Record<string, unknown> {
  const nitro = cloneNitroConfig(value)
  const plugin = root ? resolve(root, generatedNitroBlobPlugin) : generatedNitroBlobPlugin
  const middleware = root ? resolve(root, generatedNitroBlobMiddleware) : generatedNitroBlobMiddleware
  const serveHandler = root ? resolve(root, generatedBlobServeRouteHandler) : generatedBlobServeRouteHandler
  const plugins = Array.isArray(nitro.plugins)
    ? nitro.plugins.filter(entry => !isGeneratedNitroRegistration(entry, generatedNitroBlobPlugin))
    : []
  plugins.push(plugin)
  const handlers = Array.isArray(nitro.handlers)
    ? nitro.handlers.filter(handler =>
        !isGeneratedNitroRegistration(handler?.handler, generatedNitroBlobMiddleware),
      )
    : []
  if (cloudflare) handlers.unshift({ handler: middleware, middleware: true, route: "/**" })
  if (!serve) return { ...nitro, handlers, plugins }
  const existingHandlers = handlers.filter(handler =>
    !isGeneratedNitroRegistration(handler?.handler, generatedBlobServeRouteHandler),
  )
  return {
    ...nitro,
    handlers: [
      ...existingHandlers,
      { handler: serveHandler, route: blobServeNitroRoute(serve) },
    ],
    plugins,
  }
}

function renderNitroBlobPlugin(blob: BlobViteRuntimeConfig["blob"], cloudflare: boolean, importBase = blobPackageName): string {
  return [
    cloudflare ? "import { env as vitehubEnv } from 'cloudflare:workers'" : undefined,
    cloudflare ? undefined : "import './runtime.mjs'",
    `import { ${cloudflare ? "setActiveCloudflareEnv, " : ""}setBlobRuntimeConfig } from '${importBase}/runtime/state'`,
    "",
    `const blobConfig = ${JSON.stringify(blob)}`,
    "",
    "export default function vitehubBlobPlugin() {",
    cloudflare ? "  setActiveCloudflareEnv(vitehubEnv)" : undefined,
    "  setBlobRuntimeConfig(blobConfig)",
    "}",
    "",
  ].filter(line => typeof line === "string").join("\n")
}

function renderNitroBlobMiddleware(importBase = blobPackageName): string {
  return [
    "// @ts-ignore Cloudflare provides this virtual module at runtime.",
    "import { env as vitehubEnv } from 'cloudflare:workers'",
    "import { defineMiddleware } from 'nitro'",
    `import { setActiveCloudflareEnv } from '${importBase}/runtime/state'`,
    "",
    "type CloudflareEnv = Record<string, unknown>",
    "type CloudflareEvent = {",
    "  context?: { cloudflare?: { env?: CloudflareEnv }, _platform?: { cloudflare?: { env?: CloudflareEnv } } }",
    "  env?: CloudflareEnv",
    "  node?: { req?: { runtime?: { cloudflare?: { env?: CloudflareEnv } } } }",
    "  req?: { runtime?: { cloudflare?: { env?: CloudflareEnv } } }",
    "}",
    "",
    "export default defineMiddleware((event) => {",
    "  const target = event as unknown as CloudflareEvent",
    "  const env = target.env ?? target.context?.cloudflare?.env ?? target.context?._platform?.cloudflare?.env ?? target.req?.runtime?.cloudflare?.env ?? target.node?.req?.runtime?.cloudflare?.env ?? (vitehubEnv as unknown as CloudflareEnv)",
    "  setActiveCloudflareEnv(env)",
    "})",
    "",
  ].join("\n")
}

function renderBlobServeRouteHandler(serve: BlobServeConfig, importBase = blobPackageName): string {
  const headers = serve.headers && Object.keys(serve.headers).length > 0 ? serve.headers : undefined
  return [
    `import { blob } from '${importBase}'`,
    `import { createError, getRouterParam${headers ? ", removeResponseHeader, setResponseHeaders" : ""} } from 'h3'`,
    "import { defineCachedHandler } from 'nitro/cache'",
    "",
    `const storeName = ${JSON.stringify(serve.store)}`,
    ...(headers ? [`const responseHeaders = ${JSON.stringify(headers)}`] : []),
    "",
    "export default defineCachedHandler(async (event) => {",
    "  const pathname = getRouterParam(event, '_', { decode: false }) || ''",
    "  if (!pathname) throw createError({ statusCode: 404, statusMessage: 'Blob not found' })",
    ...(headers ? ["  setResponseHeaders(event, responseHeaders)"] : []),
    ...(headers
      ? [
          "  try {",
          "    const [error, stream] = await blob.store(storeName).serve(event, pathname)",
          "    if (error?.code === 'BLOB_NOT_FOUND') throw createError({ cause: error, statusCode: 404, statusMessage: 'Blob not found' })",
          "    if (error) throw error",
          "    return stream",
          "  }",
          "  catch (error) {",
          "    for (const name of Object.keys(responseHeaders)) removeResponseHeader(event, name)",
          "    throw error",
          "  }",
        ]
      : [
          "  const [error, stream] = await blob.store(storeName).serve(event, pathname)",
          "  if (error?.code === 'BLOB_NOT_FOUND') throw createError({ cause: error, statusCode: 404, statusMessage: 'Blob not found' })",
          "  if (error) throw error",
          "  return stream",
        ]),
    "}, { headersOnly: true, maxAge: 0 })",
    "",
  ].join("\n")
}

async function refreshBlobGeneratedFiles(root: string, blob: BlobViteRuntimeConfig["blob"], cloudflare: boolean, importBase = blobPackageName, provider?: "cloudflare" | "vercel"): Promise<void> {
  const runtimeFile = resolve(root, generatedNitroBlobRuntime)
  await Promise.all([
    writeFileIfChanged(runtimeFile, renderBlobRuntimeModule(runtimeFile, blob, provider)),
    writeFileIfChanged(resolve(root, generatedNitroBlobPlugin), renderNitroBlobPlugin(blob, cloudflare, importBase)),
    writeFileIfChanged(resolve(root, generatedNitroBlobMiddleware), renderNitroBlobMiddleware(importBase)),
  ])
  const serve = blob ? blob.serve : undefined
  if (!serve) return
  const file = resolve(root, generatedBlobServeRouteHandler)
  await writeFileIfChanged(file, renderBlobServeRouteHandler(serve, importBase))
}

export function hubBlob(options?: BlobModuleOptions, internalOptions: InternalBlobModuleOptions = {}): BlobVitePlugin {
  const importBase = internalOptions.importBase ?? blobPackageName
  const nitroOwned = internalOptions.nitroOwned === true
  let blob: BlobModuleOptions | undefined = options
  let clientOutDir = "dist"
  let command: "build" | "serve" = "serve"
  let cloudflareOwnedByNitro = false
  let providerArtifacts: Awaited<ReturnType<typeof prepareProviderOutputs>> | undefined
  let providerOutput: ProviderOutputCatalog | undefined
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
      const configuredNitro = (config as { nitro?: unknown }).nitro
      cloudflareOwnedByNitro = (nitroOwned || hasNitroVitePluginOption(config.plugins)) && isNitroCloudflareHost(configuredNitro)
      const blobConfig = resolveBlobViteConfig(blob, cloudflareOwnedByNitro ? { hosting: "cloudflare" } : undefined)
      const nitro = mergeNitroBlobConfig(
        configuredNitro,
        blobConfig.blob ? blobConfig.blob.serve : undefined,
        cloudflareOwnedByNitro,
      )
      const composedNitro = mergeNitroCloudflareBlobOutput(config, nitro, blob, cloudflareOwnedByNitro)
      ;(config as { nitro?: unknown }).nitro = composedNitro
    },
    async configResolved(config) {
      resolved = config
      clientOutDir = config.build.outDir
      rootDir = resolveViteHubProjectRoot(config.root)
      blob = config.blob ?? blob
      const configuredNitro = (config as { nitro?: unknown }).nitro
      cloudflareOwnedByNitro = (nitroOwned || hasNitroConfigContext(config)) && isNitroCloudflareHost(configuredNitro)
      const blobConfig = resolveBlobViteConfig(blob, cloudflareOwnedByNitro ? { hosting: "cloudflare" } : undefined)
      const nitro = mergeNitroBlobConfig(
        configuredNitro,
        blobConfig.blob ? blobConfig.blob.serve : undefined,
        cloudflareOwnedByNitro,
        rootDir,
      )
      ;(config as { nitro?: unknown }).nitro = mergeNitroCloudflareBlobOutput(config, nitro, blob, cloudflareOwnedByNitro)
      providerOutput = useProviderOutputCatalog(config)
      runtimeConfig = blobConfig
      const hosting = getNitroHostingProvider(configuredNitro)
        ?? (resolveNitroVercelFunctionName(config, "blob") ? "vercel" : undefined)
      await refreshBlobGeneratedFiles(
        rootDir,
        runtimeConfig.blob,
        cloudflareOwnedByNitro,
        importBase,
        hosting === "cloudflare" || hosting === "vercel" ? hosting : undefined,
      )
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
      resetProviderDeploymentOutputs(providerOutput)
      resetProviderOutputRuntime(providerOutput)
    },
    async buildEnd() {
      if (shouldSkipViteProviderBuild(command, getViteMode())) {
        return
      }

      providerArtifacts = await prepareProviderOutputs({
        blob,
        cloudflareOwnedByNitro,
        providerOutput,
        rootDir,
      })
      contributeProviderDeploymentOutput(providerOutput, {
        owner: "blob",
        rootDir,
        write: async ({ write }) => {
          await generateProviderOutputs({
            blob,
            clientOutDir,
            cloudflareOwnedByNitro,
            artifacts: providerArtifacts,
            providerOutput,
            rootDir,
            serverFunctionName: resolveNitroVercelFunctionName(resolved ?? {}, "blob"),
          }, write)
        },
      })
    },
    closeBundle: {
      order: "post",
      async handler() {
        if (shouldSkipViteProviderBuild(command, getViteMode())) return
        await finalizeProviderDeploymentOutputs(providerOutput)
      },
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
