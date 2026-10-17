import * as v from "valibot"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { getViteMode } from "@vite-hub/internal/build/mode"
import { composeNitroCloudflareProviderOutput, contributeCloudflareProviderOutput, contributeProviderDeploymentOutput, createDefaultCloudflareOutputRoot, createDefaultVercelOutputRoot, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, resetProviderOutputRuntime, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { removeProviderOutputArtifactDir } from "@vite-hub/internal/build/provider-output-sources"
import { createNoExternalAddition, hasNitroConfigContext, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { renderViteHubNitroDevHandler } from "@vite-hub/internal/dev-endpoint"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { isPlainObject } from "@vite-hub/internal/object"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { createViteHubDevToken } from "@vite-hub/internal/dev-token"
import { findExportNames, hasCJSSyntax } from "mlly"
import { transform } from "esbuild"
import { init as initCommonJS, parse as parseCommonJS } from "cjs-module-lexer"
import { relative, resolve } from "pathe"

import { blobDevRuntimeRoute, blobDevTokenNamespace, blobDevTokenServerHeader } from "./dev.ts"
import { createCloudflareR2Bindings, generateProviderOutputs, prepareProviderOutputs, registerSupportedProviderRuntimeModules, renderBlobRuntimeModule, blobPackageName } from "./internal/vite-build.ts"
import { createBlobCloudflareProvisionStep, createBlobVercelProvisionStep } from "./provision.ts"
import {
  BLOB_VIRTUAL_CONFIG_ID,
  BLOB_VITE_PLUGIN_NAME,
  resolveBlobViteConfig,
} from "./vite-config.ts"
import { registerBlobDevEndpoint } from "./vite-dev.ts"

import type { BlobViteRuntimeConfig } from "./vite-config.ts"
import type { BlobModuleOptions, BlobServeConfig } from "./types.ts"
import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ViteHubInspectionContributor } from "@vite-hub/internal/inspect"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"
import type { ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { Plugin, ResolvedConfig } from "vite"

const RESOLVED_BLOB_VIRTUAL_CONFIG_ID = `\0${BLOB_VIRTUAL_CONFIG_ID}`
const generatedNitroBlobPlugin = ".vitehub/nitro/blob/plugin.ts"
const generatedNitroBlobRuntime = ".vitehub/nitro/blob/runtime.mjs"
const generatedNitroBlobMiddleware = ".vitehub/nitro/blob/middleware.ts"
const generatedBlobServeRouteHandler = ".vitehub/blob/serve-route.ts"
const generatedNitroBlobDevHandler = ".vitehub/nitro/blob/dev-handler.ts"
const blobServeModuleExtensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]
const AUTH_SERVER_ID = "#vitehub/auth/server"
const AUTH_VITE_PLUGIN_NAME = "@vite-hub/auth/vite"

export { BLOB_VIRTUAL_CONFIG_ID, BLOB_VITE_PLUGIN_NAME, resolveBlobViteConfig }
export type { BlobViteRuntimeConfig } from "./vite-config.ts"

export interface BlobVitePluginAPI {
  getConfig: () => BlobViteRuntimeConfig
}

interface BlobProvisionContributingPlugin {
  vitehub?: {
    cli?: () => Promise<ViteHubCliContributor>
    inspect?: () => ViteHubInspectionContributor | undefined
  }
}

export type BlobVitePlugin = Plugin & BlobProvisionContributingPlugin & { api: BlobVitePluginAPI }

interface InternalBlobModuleOptions {
  importBase?: string
  nitroOwned?: boolean
}

const mergeNoExternal = createNoExternalAddition(blobPackageName)

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

function blobCreatesProviderOutput(blob: BlobViteRuntimeConfig["blob"]): boolean {
  if (!blob) return false
  const stores = "stores" in blob && blob.stores ? Object.values(blob.stores) : [blob.store]
  return stores.every(store => store.driver !== "fs")
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

/**
 * Merges the generated Blob registrations into the Nitro config. `devHandler` is the absolute path of the Nitro route
 * that `vitehub blob` commands reach. Pass it only in `vite dev`.
 */
function mergeNitroBlobConfig(value: unknown, serve: BlobServeConfig | undefined, cloudflare: boolean, root?: string, devHandler?: string): Record<string, unknown> {
  const nitro = cloneNitroConfig(value)
  const plugin = root ? resolve(root, generatedNitroBlobPlugin) : generatedNitroBlobPlugin
  const middleware = root ? resolve(root, generatedNitroBlobMiddleware) : generatedNitroBlobMiddleware
  const serveHandler = root ? resolve(root, generatedBlobServeRouteHandler) : generatedBlobServeRouteHandler
  nitro.plugins = Array.isArray(nitro.plugins)
    ? nitro.plugins.filter(entry => !isGeneratedNitroRegistration(entry, generatedNitroBlobPlugin))
    : []
  nitro.handlers = Array.isArray(nitro.handlers)
    ? nitro.handlers.filter(handler =>
        !isGeneratedNitroRegistration(handler?.handler, generatedNitroBlobMiddleware)
        && !isGeneratedNitroRegistration(handler?.handler, generatedNitroBlobDevHandler),
      )
    : []
  const kit = createNitroServerKit(nitro)
  kit.addPlugin(plugin)
  if (cloudflare) kit.addHandler({ handler: middleware, middleware: true, route: "/**" })
  if (devHandler) kit.addHandler({ handler: devHandler, route: blobDevRuntimeRoute })
  if (!serve) return kit.config
  if (Array.isArray(kit.config.handlers)) {
    const existingHandlers = kit.config.handlers.filter(handler =>
      !isGeneratedNitroRegistration(handler?.handler, generatedBlobServeRouteHandler),
    )
    kit.config.handlers.splice(0, kit.config.handlers.length, ...existingHandlers)
  }
  kit.addHandler({ handler: serveHandler, route: blobServeNitroRoute(serve) })
  return kit.config
}

function renderNitroBlobPlugin(blob: BlobViteRuntimeConfig["blob"], cloudflare: boolean, importBase = blobPackageName): string {
  return [
    cloudflare ? "import { env as vitehubEnv } from 'cloudflare:workers'" : undefined,
    cloudflare ? undefined : "import { blobConfig } from './runtime.mjs'",
    `import { ${cloudflare ? "setActiveCloudflareEnv, " : ""}setBlobRuntimeConfig } from '${importBase}/runtime/state'`,
    "",
    cloudflare ? `const blobConfig = ${JSON.stringify(blob)}` : undefined,
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

function renderBlobServeRouteHandler(serve: BlobServeConfig, importBase = blobPackageName, authorizeModule?: string): string {
  const headers = serve.headers && Object.keys(serve.headers).length > 0 ? serve.headers : undefined
  // Authorized objects belong to one user, so shared caches must not store them unless the app sets its own policy.
  const cacheControl = Object.entries(headers ?? {}).findLast(([name]) => name.toLowerCase() === "cache-control")?.[1]
    ?? (serve.authorize ? "private, no-cache" : undefined)
  return [
    `import { blob } from '${importBase}'`,
    ...(serve.authorize ? [`import { withAuthorization } from ${JSON.stringify(AUTH_SERVER_ID)}`] : []),
    ...(authorizeModule ? [`import { authorize } from ${JSON.stringify(authorizeModule)}`] : []),
    `import { createError, ${serve.authorize ? "defineHandler, " : ""}getRouterParam${cacheControl !== undefined ? ", handleCacheHeaders, setResponseHeader" : ""}${headers ? ", removeResponseHeader, setResponseHeaders" : ""} } from 'h3'`,
    ...(serve.authorize ? ["import type { H3Event } from 'h3'"] : []),
    "import { defineCachedHandler } from 'nitro/cache'",
    "",
    `const storeName = ${JSON.stringify(serve.store)}`,
    ...(headers ? [`const responseHeaders = ${JSON.stringify(headers)}`] : []),
    "",
    `${serve.authorize ? "const serveBlob =" : "export default"} defineCachedHandler(async (event) => {`,
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
    ...(cacheControl !== undefined
      ? [
          "}, {",
          "  headersOnly: true,",
          "  maxAge: 0,",
          "  // Keep the configured policy after conditional request handling sets default cache headers.",
          "  handleCacheHeaders(event, conditions) {",
          "    const handled = handleCacheHeaders(event, conditions)",
          `    setResponseHeader(event, 'Cache-Control', ${JSON.stringify(cacheControl)})`,
          "    return handled",
          "  },",
          "})",
        ]
      : ["}, { headersOnly: true, maxAge: 0 })"]),
    ...(serve.authorize
      ? [
          "",
          "// Authorize before the store read and before conditional request handling.",
          `export default defineHandler(withAuthorization(${authorizeModule ? "authorize" : "true"}, (event: H3Event) => serveBlob(event)))`,
        ]
      : []),
    "",
  ].join("\n")
}

function hasAuthDefinition(plugins: readonly unknown[]): boolean {
  return plugins.flat(Infinity).some((plugin) => {
    if (Object(plugin) !== plugin || Reflect.get(Object(plugin), "name") !== AUTH_VITE_PLUGIN_NAME) return false
    const getConfig: unknown = Reflect.get(Object(Reflect.get(Object(plugin), "api")), "getConfig")
    return getConfig instanceof Function && getConfig() !== undefined
  })
}

async function discoverBlobAuthorizeModule(rootDir: string, serverDirs: string[] | undefined): Promise<string | undefined> {
  const directories = (serverDirs === undefined ? ["server"] : serverDirs).map(directory => resolve(rootDir, directory))
  const files = directories
    .flatMap(directory => blobServeModuleExtensions.map(extension => resolve(directory, `blob${extension}`)))
    .filter(file => existsSync(file))
  if (files.length > 1) {
    throw blobErrorDiagnostics.BLOB_B0003({ message: `[vitehub] Only one Blob serve module is allowed. Found:\n${files.map(file => `  - ${file}`).join("\n")}` })
  }
  const file = files[0]
  if (!file) return
  const source = await readFile(file, "utf8")
  if (findExportNames(source).includes("authorize")) return file
  if (!file.endsWith(".cts") && !file.endsWith(".cjs") && !hasCJSSyntax(source)) return
  const commonJS = file.endsWith(".cts") ? (await transform(source, { loader: "ts" })).code : source
  await initCommonJS()
  return parseCommonJS(commonJS, file).exports.includes("authorize") ? file : undefined
}

async function resolveBlobServeAuthorizeModule(
  config: ResolvedConfig,
  rootDir: string,
  serve: BlobServeConfig | undefined,
): Promise<string | undefined> {
  if (!serve) return
  // SAFETY: ViteHub hosts add the shared server directory symbol to the resolved Vite config.
  const serverDirs = (config as ResolvedConfig & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
  const authorizeModule = await discoverBlobAuthorizeModule(rootDir, serverDirs)
  if (authorizeModule && !serve.authorize) {
    throw blobErrorDiagnostics.BLOB_B0001({ message: `[vitehub] ${JSON.stringify(authorizeModule)} exports \`authorize\`, but \`blob.serve.authorize\` is not true. Set \`blob.serve.authorize: true\` so the serve route uses it.` })
  }
  if (serve.authorize && !hasAuthDefinition(config.plugins)) {
    throw blobErrorDiagnostics.BLOB_B0002({ message: "[vitehub] `blob.serve.authorize` requires an Auth Definition. Enable Auth and add `server/auth.ts`." })
  }
  return authorizeModule
}

function resolveBlobDevHandler(root: string): string {
  return resolve(resolveViteHubProjectRoot(root), generatedNitroBlobDevHandler)
}

/** Writes the Nitro route that `vitehub blob` commands reach. The Vite dev endpoint guards every request to it. */
async function writeBlobDevHandler(file: string, importBase: string, rootDir: string, serverId: string): Promise<void> {
  await writeFileIfChanged(file, renderViteHubNitroDevHandler({ arguments: [rootDir, serverId], export: "handleBlobDevRequest", module: `${importBase}/runtime/dev` }))
}

function readNitroBaseURL(config: ResolvedConfig | undefined): string | undefined {
  const nitro: unknown = config ? Reflect.get(config, "nitro") : undefined
  const baseURL: unknown = isPlainObject(nitro) ? Reflect.get(nitro, "baseURL") : undefined
  return v.is(v.string(), baseURL) ? baseURL : process.env.NITRO_APP_BASE_URL
}

function isAuthDefinitionPath(file: string, rootDir: string, serverDirs: string[] | undefined): boolean {
  const projectRelativePath = relative(rootDir, resolve(file)).replaceAll("\\", "/")
  if (/^server\.auth\.(?:[cm]?[jt]s)$/.test(projectRelativePath)) return true
  const directories = serverDirs === undefined ? [resolve(rootDir, "server")] : serverDirs.map(directory => resolve(rootDir, directory))
  return directories.some(directory => {
    const path = relative(directory, resolve(file)).replaceAll("\\", "/")
    return !path.startsWith("../") && !path.startsWith("/") && /^auth\.(?:[cm]?[jt]s)$/.test(path)
  })
}

async function refreshBlobGeneratedFiles(root: string, blob: BlobViteRuntimeConfig["blob"], cloudflare: boolean, importBase = blobPackageName, provider?: "cloudflare" | "vercel", authorizeModule?: string): Promise<void> {
  const runtimeFile = resolve(root, generatedNitroBlobRuntime)
  await Promise.all([
    writeFileIfChanged(runtimeFile, renderBlobRuntimeModule(runtimeFile, blob, provider)),
    writeFileIfChanged(resolve(root, generatedNitroBlobPlugin), renderNitroBlobPlugin(blob, cloudflare, importBase)),
    writeFileIfChanged(resolve(root, generatedNitroBlobMiddleware), renderNitroBlobMiddleware(importBase)),
  ])
  const serve = blob ? blob.serve : undefined
  if (!serve) return
  const file = resolve(root, generatedBlobServeRouteHandler)
  await writeFileIfChanged(file, renderBlobServeRouteHandler(serve, importBase, authorizeModule))
}

export function hubBlob(options?: BlobModuleOptions, internalOptions: InternalBlobModuleOptions = {}): BlobVitePlugin {
  const importBase = internalOptions.importBase ?? blobPackageName
  const nitroOwned = internalOptions.nitroOwned === true
  let blob: BlobModuleOptions | undefined = options
  let clientOutDir = "dist"
  let command: "build" | "serve" = "serve"
  let cloudflareOwnedByNitro = false
  let providerOutput: ProviderOutputCatalog | undefined
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  let rootDir = process.cwd()
  let runtimeConfig: BlobViteRuntimeConfig | undefined
  let devTokenServerId: string | undefined
  let resolved: ResolvedConfig | undefined
  const stagedArtifactDirs = new WeakMap<object, string>()
  const fallbackEnvironment = {}
  const buildEnvironment = (context: { environment?: object } | undefined): object =>
    context?.environment ?? context ?? fallbackEnvironment
  const getConfig = () => runtimeConfig ??= resolveBlobViteConfig(options)

  return {
    name: BLOB_VITE_PLUGIN_NAME,
    api: { getConfig },
    vitehub: {
      cli: async () => {
        const { createBlobCliNamespaces } = await import(/* @vite-ignore */ "./cli.js")
        return {
          namespaces: createBlobCliNamespaces(),
          provision: [createBlobCloudflareProvisionStep(() => blob), createBlobVercelProvisionStep(() => blob)],
        }
      },
      inspect: () => {
        if (!runtimeConfig || !blobCreatesProviderOutput(runtimeConfig.blob) || cloudflareOwnedByNitro) return
        const projectRoot = resolveViteHubProjectRoot(resolved?.root ?? process.cwd())
        const functionName = resolveNitroVercelFunctionName(resolved ?? {}, "blob") ?? "__server.func"
        return {
          providerOutput: [
            { description: "Generated Cloudflare Blob worker", owner: "blob", path: resolve(createDefaultCloudflareOutputRoot(projectRoot), "index.js") },
            { description: "Generated Vercel Blob function", owner: "blob", path: resolve(createDefaultVercelOutputRoot(projectRoot), "functions", functionName, "index.mjs") },
          ],
        }
      },
    },
    config(config, env) {
      command = env.command
      blob = config.blob ?? blob
      const configuredNitro = (config as { nitro?: unknown }).nitro
      const nitroConfigContext = hasNitroConfigContext(config)
      const nitroOwnsConfig = nitroOwned || nitroConfigContext || hasNitroVitePluginOption(config.plugins)
      cloudflareOwnedByNitro = nitroOwnsConfig && isNitroCloudflareHost(configuredNitro)
      const blobConfig = resolveBlobViteConfig(blob, cloudflareOwnedByNitro ? { hosting: "cloudflare" } : undefined)
      const nitro = mergeNitroBlobConfig(
        configuredNitro,
        blobConfig.blob ? blobConfig.blob.serve : undefined,
        cloudflareOwnedByNitro,
        nitroConfigContext ? resolveViteHubProjectRoot(config.root || process.cwd()) : undefined,
        command === "serve" ? resolveBlobDevHandler(config.root || process.cwd()) : undefined,
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
      const devHandler = config.command === "serve" ? resolveBlobDevHandler(rootDir) : undefined
      const nitro = mergeNitroBlobConfig(
        configuredNitro,
        blobConfig.blob ? blobConfig.blob.serve : undefined,
        cloudflareOwnedByNitro,
        rootDir,
        devHandler,
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
        await resolveBlobServeAuthorizeModule(config, rootDir, runtimeConfig.blob ? runtimeConfig.blob.serve : undefined),
      )
      if (devHandler) {
        devTokenServerId = (await createViteHubDevToken(rootDir, blobDevTokenNamespace)).serverId
        await writeBlobDevHandler(devHandler, importBase, rootDir, devTokenServerId)
      }
    },
    configureServer(server) {
      registerBlobDevEndpoint(server, {
        devTokenServerId: () => devTokenServerId,
        discovery: () => devTokenServerId ? { blobDevTokenServerId: devTokenServerId } : {},
        forwardHeaders: ["x-vitehub-dev-token", blobDevTokenServerHeader],
        nitroBaseURL: () => readNitroBaseURL(resolved),
      })
      if (!runtimeConfig?.blob || !runtimeConfig.blob.serve?.authorize) return
      // SAFETY: ViteHub hosts add the optional shared server directories to the resolved Vite config.
      const serverDirs = (server.config as ResolvedConfig & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
      const watchedDirectories = (serverDirs ?? [resolve(rootDir, "server")]).map(directory => resolve(rootDir, directory))
      server.watcher.add([...watchedDirectories, rootDir])
      const restartForAuthChange = (file: string) => {
        if (!isAuthDefinitionPath(file, rootDir, serverDirs)) return
        void server.restart()
      }
      server.watcher.on("add", restartForAuthChange)
      server.watcher.on("unlink", restartForAuthChange)
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
      providerOutputGenerations.capture(this, providerOutput)
      resetProviderOutputRuntime(providerOutput)
    },
    async buildEnd(error) {
      if (error) {
        await providerOutputGenerations.reset(this, providerOutput, error)
        return
      }
      if (shouldSkipViteProviderBuild(command, getViteMode())) {
        return
      }
      const generation = providerOutputGenerations.get(this)
      const environment = generation ?? buildEnvironment(this)
      const artifactDir = resolve(rootDir, ".vitehub/blob-generations", randomUUID())
      try {
        const blobOptions = blob
        const blobCloudflareOwnedByNitro = cloudflareOwnedByNitro
        const blobClientOutDir = clientOutDir
        const blobRootDir = rootDir
        const blobServerFunctionName = resolveNitroVercelFunctionName(resolved ?? {}, "blob")
        const providerArtifacts = await prepareProviderOutputs({
          blob: blobOptions,
          cloudflareOwnedByNitro: blobCloudflareOwnedByNitro,
          generatedDir: artifactDir,
          providerOutput,
          rootDir: blobRootDir,
        })
        registerSupportedProviderRuntimeModules(providerOutput, providerArtifacts, blobOptions, blobCloudflareOwnedByNitro, generation)
        stagedArtifactDirs.set(environment, artifactDir)
        contributeProviderDeploymentOutput(providerOutput, {
          discard: async () => {
            await removeProviderOutputArtifactDir(artifactDir)
            if (stagedArtifactDirs.get(environment) === artifactDir) stagedArtifactDirs.delete(environment)
          },
          owner: "blob",
          rootDir: blobRootDir,
          write: async ({ signal, write }) => {
            await generateProviderOutputs({
              blob: blobOptions,
              clientOutDir: blobClientOutDir,
              cloudflareOwnedByNitro: blobCloudflareOwnedByNitro,
              artifacts: providerArtifacts,
              providerOutput,
              rootDir: blobRootDir,
              serverFunctionName: blobServerFunctionName,
              signal,
            }, write)
          },
        }, generation)
      }
      catch (error) {
        await removeProviderOutputArtifactDir(artifactDir)
        if (stagedArtifactDirs.get(environment) === artifactDir) stagedArtifactDirs.delete(environment)
        await providerOutputGenerations.reset(this, providerOutput, error)
        throw error
      }
    },
    async renderError(error) {
      const environment = providerOutputGenerations.get(this) ?? buildEnvironment(this)
      await providerOutputGenerations.reset(this, providerOutput, error)
      const artifactDir = stagedArtifactDirs.get(environment)
      if (artifactDir) {
        await removeProviderOutputArtifactDir(artifactDir)
        if (stagedArtifactDirs.get(environment) === artifactDir) stagedArtifactDirs.delete(environment)
      }
    },
    closeBundle: {
      order: "post",
      sequential: true,
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
