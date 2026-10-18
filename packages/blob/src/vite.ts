import * as v from "valibot"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { composeNitroCloudflareProviderOutput, contributeCloudflareProviderOutput, contributeProviderRuntime, createProviderDeploymentOutputGenerationState, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalAddition, hasNitroConfigContext, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { renderViteHubNitroDevHandler } from "@vite-hub/internal/dev-endpoint"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { isPlainObject } from "@vite-hub/internal/object"
import { getHostingProvider, resolveHost } from "@vite-hub/internal/hosting"
import { createViteHubDevToken } from "@vite-hub/internal/dev-token"
import { findExportNames, hasCJSSyntax } from "mlly"
import { transform } from "esbuild"
import { init as initCommonJS, parse as parseCommonJS } from "cjs-module-lexer"
import { relative, resolve } from "pathe"

import { blobDevRuntimeRoute, blobDevTokenNamespace, blobDevTokenServerHeader } from "./dev.ts"
import { blobPackageName, createCloudflareR2Bindings, getBlobVercelRuntimePackages, renderBlobRuntimeModule } from "./internal/nitro-runtime.ts"
import { createBlobCloudflareProvisionStep, createBlobVercelProvisionStep } from "./provision.ts"
import {
  BLOB_VIRTUAL_CONFIG_ID,
  BLOB_VITE_PLUGIN_NAME,
  resolveBlobViteConfig,
} from "./vite-config.ts"
import { registerBlobDevEndpoint } from "./vite-dev.ts"

import type { BlobViteRuntimeConfig } from "./vite-config.ts"
import type { BlobModuleOptions, BlobServeConfig, ResolvedBlobModuleOptions } from "./types.ts"
import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"
import { findMissingFilesSdkPeers } from "./internal/files-sdk-peers.ts"
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
  }
}

export type BlobVitePlugin = Plugin & BlobProvisionContributingPlugin & { api: BlobVitePluginAPI }

interface InternalBlobModuleOptions {
  importBase?: string
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

function mergeNitroExternal(value: unknown, addition: string): unknown {
  if (typeof value === "undefined") return [addition]
  if (Array.isArray(value)) return value.includes(addition) ? [...value] : [...value, addition]
  if (typeof value === "string" || value instanceof RegExp) return [value, addition]
  if (typeof value === "function") {
    return (source: string, importer?: string, isResolved?: boolean) => source === addition || Boolean(value(source, importer, isResolved))
  }
  return value
}

type BlobRuntimeContribution = Parameters<typeof contributeProviderRuntime>[1]

function hasFsStore(blob: ResolvedBlobModuleOptions): boolean {
  return Object.values(blob.stores || { default: blob.store }).some(store => store.driver === "fs")
}

/**
 * Queue, Database, and Workflow still bundle their own host functions. They alias `@vite-hub/blob` to this
 * contribution so Blob calls in those functions use the same generated Nitro runtime module.
 */
function createSiblingRuntimeContribution(root: string, blob: BlobViteRuntimeConfig["blob"], provider: "cloudflare" | "vercel" | undefined): BlobRuntimeContribution | undefined {
  if (!blob || !provider || hasFsStore(blob)) return
  const runtimeFile = resolve(root, generatedNitroBlobRuntime)
  return provider === "cloudflare"
    ? { owner: "blob", runtimeModules: { cloudflare: runtimeFile } }
    : { owner: "blob", runtimeModules: { vercel: runtimeFile }, vercelRuntimePackages: getBlobVercelRuntimePackages(blob) }
}

function isNitroCloudflareHost(value: unknown): boolean {
  return resolveHost({ nitro: value }) === "cloudflare"
}

function mergeNitroCloudflareBlobOutput(config: object, nitro: Record<string, unknown>, blob: BlobModuleOptions | undefined, cloudflareHost: boolean): Record<string, unknown> {
  const providerOutput = useProviderOutputCatalog(config)
  if (!cloudflareHost) {
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

/**
 * `workersModule` is false in `vite dev`. The Nitro dev runner can be Node (`node-worker`), where `cloudflare:workers`
 * does not exist. The workerd runner gives each request its bindings, so dev code reads them from the event.
 */
function renderNitroBlobPlugin(blob: BlobViteRuntimeConfig["blob"], cloudflare: boolean, importBase = blobPackageName, workersModule = true): string {
  const cloudflareGlobals = cloudflare && workersModule
  return [
    cloudflareGlobals ? "import { env as vitehubEnv } from 'cloudflare:workers'" : undefined,
    cloudflare ? undefined : "import { blobConfig } from './runtime.mjs'",
    `import { ${cloudflareGlobals ? "setActiveCloudflareEnv, " : ""}setBlobRuntimeConfig } from '${importBase}/runtime/state'`,
    "",
    cloudflare ? `const blobConfig = ${JSON.stringify(blob)}` : undefined,
    "",
    "export default function vitehubBlobPlugin() {",
    cloudflareGlobals ? "  setActiveCloudflareEnv(vitehubEnv)" : undefined,
    "  setBlobRuntimeConfig(blobConfig)",
    "}",
    "",
  ].filter(line => typeof line === "string").join("\n")
}

function renderNitroBlobMiddleware(importBase = blobPackageName, workersModule = true): string {
  const requestEnv = "target.env ?? target.context?.cloudflare?.env ?? target.context?._platform?.cloudflare?.env ?? target.req?.runtime?.cloudflare?.env ?? target.node?.req?.runtime?.cloudflare?.env"
  return [
    ...(workersModule
      ? [
          "// @ts-ignore Cloudflare provides this virtual module at runtime.",
          "import { env as vitehubEnv } from 'cloudflare:workers'",
        ]
      : []),
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
    ...(workersModule
      ? [`  const env = ${requestEnv} ?? (vitehubEnv as unknown as CloudflareEnv)`, "  setActiveCloudflareEnv(env)"]
      : [
          "  // A Node dev runner has no Cloudflare env. Keep the active env as it is.",
          `  const env = ${requestEnv}`,
          "  if (env) setActiveCloudflareEnv(env)",
        ]),
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

async function refreshBlobGeneratedFiles(root: string, blob: BlobViteRuntimeConfig["blob"], cloudflare: boolean, importBase = blobPackageName, provider?: "cloudflare" | "vercel", authorizeModule?: string, development = false): Promise<void> {
  const runtimeFile = resolve(root, generatedNitroBlobRuntime)
  await Promise.all([
    writeFileIfChanged(runtimeFile, renderBlobRuntimeModule(runtimeFile, blob, provider)),
    writeFileIfChanged(resolve(root, generatedNitroBlobPlugin), renderNitroBlobPlugin(blob, cloudflare, importBase, !development)),
    writeFileIfChanged(resolve(root, generatedNitroBlobMiddleware), renderNitroBlobMiddleware(importBase, !development)),
  ])
  const serve = blob ? blob.serve : undefined
  if (!serve) return
  const file = resolve(root, generatedBlobServeRouteHandler)
  await writeFileIfChanged(file, renderBlobServeRouteHandler(serve, importBase, authorizeModule))
}

function assertDriverSdksInstalled(blob: BlobViteRuntimeConfig["blob"], nativeCloudflareR2 = false) {
  if (!blob) return
  const stores = Object.values(blob.stores ?? { default: blob.store })
  // The native module is selected only when every configured R2 store has a
  // binding. Keep the SDK check for mixed configurations that still import
  // the HTTP/S3 implementation.
  const cloudflareR2Stores = stores.filter(store => store.driver === "cloudflare-r2")
  const nativeR2 = nativeCloudflareR2
    && cloudflareR2Stores.length > 0
    && cloudflareR2Stores.every(store => Boolean(store.bucketName))
  const skipDrivers = nativeR2
    ? ["cloudflare-r2" as const]
    : []
  const missing = findMissingFilesSdkPeers(stores.map(store => store.driver), undefined, skipDrivers)
  if (!missing.length) return
  const lines = missing.map(({ driver, peers }) => `The "${driver}" blob driver requires ${peers.join(", ")}.`)
  const install = [...new Set(missing.flatMap(({ peers }) => peers))].join(" ")
  throw blobErrorDiagnostics.BLOB_B0004({ message: `[vitehub] ${lines.join(" ")} Install it in your app with: pnpm add ${install}` })
}

export function hubBlob(options?: BlobModuleOptions, internalOptions: InternalBlobModuleOptions = {}): BlobVitePlugin {
  const importBase = internalOptions.importBase ?? blobPackageName
  let blob: BlobModuleOptions | undefined = options
  let rootDir = process.cwd()
  let runtimeConfig: BlobViteRuntimeConfig | undefined
  let devTokenServerId: string | undefined
  // Nuxt replays `config` with the host command, but its replayed resolved config has no `command`.
  let command: string | undefined
  let resolved: ResolvedConfig | undefined
  let siblingRuntime: BlobRuntimeContribution | undefined
  const siblingRuntimeGenerations = createProviderDeploymentOutputGenerationState()
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
    },
    config(config, env) {
      command = env.command
      blob = config.blob ?? blob
      const configuredNitro = (config as { nitro?: unknown }).nitro
      const cloudflare = isNitroCloudflareHost(configuredNitro)
      const blobConfig = resolveBlobViteConfig(blob, cloudflare ? { hosting: "cloudflare" } : undefined)
      const nitro = mergeNitroBlobConfig(
        configuredNitro,
        blobConfig.blob ? blobConfig.blob.serve : undefined,
        cloudflare,
        hasNitroConfigContext(config) ? resolveViteHubProjectRoot(config.root || process.cwd()) : undefined,
        env.command === "serve" ? resolveBlobDevHandler(config.root || process.cwd()) : undefined,
      )
      const composedNitro = mergeNitroCloudflareBlobOutput(config, nitro, blob, cloudflare)
      ;(config as { nitro?: unknown }).nitro = composedNitro
    },
    async configResolved(config) {
      resolved = config
      rootDir = resolveViteHubProjectRoot(config.root)
      blob = config.blob ?? blob
      const configuredNitro = (config as { nitro?: unknown }).nitro
      const cloudflare = isNitroCloudflareHost(configuredNitro)
      const blobConfig = resolveBlobViteConfig(blob, cloudflare ? { hosting: "cloudflare" } : undefined)
      const devHandler = config.command === "serve" ? resolveBlobDevHandler(rootDir) : undefined
      const nitro = mergeNitroBlobConfig(
        configuredNitro,
        blobConfig.blob ? blobConfig.blob.serve : undefined,
        cloudflare,
        rootDir,
        devHandler,
      )
      ;(config as { nitro?: unknown }).nitro = mergeNitroCloudflareBlobOutput(config, nitro, blob, cloudflare)
      runtimeConfig = blobConfig
      const hosting = getHostingProvider(resolveHost({ nitro: configuredNitro }))
        ?? blobConfig.hosting
        ?? (resolveNitroVercelFunctionName(config, "blob") ? "vercel" : undefined)
      if (config.command === "build") assertDriverSdksInstalled(blobConfig.blob, cloudflare)
      const provider = hosting === "cloudflare" || hosting === "vercel" ? hosting : undefined
      siblingRuntime = createSiblingRuntimeContribution(rootDir, runtimeConfig.blob, provider)
      if (siblingRuntime) {
        contributeProviderRuntime(useProviderOutputCatalog(config), siblingRuntime)
      }
      await refreshBlobGeneratedFiles(
        rootDir,
        runtimeConfig.blob,
        cloudflare,
        importBase,
        provider,
        await resolveBlobServeAuthorizeModule(config, rootDir, runtimeConfig.blob ? runtimeConfig.blob.serve : undefined),
        (config.command ?? command) === "serve",
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
      siblingRuntimeGenerations.capture(this, resolved && useProviderOutputCatalog(resolved))
      if (!resolved || !siblingRuntime) return
      contributeProviderRuntime(useProviderOutputCatalog(resolved), siblingRuntime, siblingRuntimeGenerations.get(this))
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
