import { installStandaloneOperationRpc, publishStandaloneOperationServer } from "@vite-hub/internal/operations-vite"
import { durabilityModuleFile } from "@vite-hub/internal/durability"
import { ownModule } from "@vite-hub/internal/build/paths"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { composeNitroCloudflareProviderOutput, contributeCloudflareProviderOutput, contributeProviderRuntime, createProviderDeploymentOutputGenerationState, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalAddition, getDeploymentPreset, getResolvedFeatureOptions, hasNitroConfigContext, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot, VITEHUB_PREPARE, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createNitroServerKit, mergeNitroExternal } from "@vite-hub/internal/nitro-kit"
import { getHostingProvider, resolveHost } from "@vite-hub/internal/hosting"
import { cloneRecord as cloneNitroConfig } from "@vite-hub/internal/object"
import { normalizeRoute } from "h3"
import { init as initCommonJS, parse as parseCommonJS } from "cjs-module-lexer"
import { dirname, relative, resolve } from "pathe"

import { vercelFunctionRequestBodyBytes } from "./internal/host-limits.ts"
import { blobPackageName, cloudflareImagesBinding, createCloudflareR2Bindings, getBlobVercelRuntimePackages, renderBlobRuntimeModule } from "./internal/nitro-runtime.ts"
import { blobSignedRoute } from "./internal/fs-sign.ts"
import { inspectBlobResources } from "./inspect.ts"
import { createBlobCloudflareProvisionStep, createBlobVercelProvisionStep } from "./provision.ts"
import {
  BLOB_VIRTUAL_CONFIG_ID,
  BLOB_VITE_PLUGIN_NAME,
  resolveBlobViteConfig,
} from "./vite-config.ts"

import type { BlobViteRuntimeConfig } from "./vite-config.ts"
import type { BlobOptions, BlobServeConfig, ResolvedBlobModuleOptions, ResolvedBlobStoreConfig } from "./types.ts"
import type { DurabilityPluginMetadata } from "@vite-hub/internal/durability"
import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ViteHubDefinitionSummary, ViteHubInspectionContributor } from "@vite-hub/internal/inspect"
import type { OperationContributionEntry } from "@vite-hub/internal/operations"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"
import { findMissingFilesSdkPeers } from "./internal/files-sdk-peers.ts"
import type { Plugin, ResolvedConfig } from "vite"

// Generated code imports these modules by path, so they need no package export.
const operationsModule = ownModule(import.meta.url, "operations")
const runtimeStateModule = ownModule(import.meta.url, "runtime/state")
const signedRouteModule = ownModule(import.meta.url, "runtime/signed")
const signedNitroRoute = `${blobSignedRoute}/**`

const RESOLVED_BLOB_VIRTUAL_CONFIG_ID = `\0${BLOB_VIRTUAL_CONFIG_ID}`
const generatedNitroBlobPlugin = ".vitehub/nitro/blob/plugin.ts"
const generatedNitroBlobRuntime = ".vitehub/nitro/blob/runtime.mjs"
const generatedNitroBlobMiddleware = ".vitehub/nitro/blob/middleware.ts"
const generatedBlobServeRouteHandler = ".vitehub/blob/serve-route.ts"
const generatedBlobTypes = ".vitehub/types/blob.d.ts"
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
    inspect?: () => ViteHubInspectionContributor
  }
}

export type BlobVitePlugin = Plugin & BlobProvisionContributingPlugin & { api: BlobVitePluginAPI, vitehub: DurabilityPluginMetadata & { operations: readonly OperationContributionEntry[] } }

interface InternalBlobModuleOptions {
  importBase?: string
  /** Whether the effective options still use a preset driver after application config hooks. */
  presetDriver?: boolean | ((options: BlobOptions | undefined) => boolean)
}

const mergeNoExternal = createNoExternalAddition(blobPackageName)

function describeDevelopmentStore(store: ResolvedBlobStoreConfig): string {
  if (store.remote) return "Remote. `vite dev` uses the real store, so writes change real data."
  if (store.driver === "fs") return `Local. \`vite dev\` uses the \`fs\` driver in ${store.base}.`
  if (store.driver === "cloudflare-r2" && store.localFallback) {
    return `Local. \`vite dev\` uses the R2 binding of the dev runner, or the \`fs\` driver in ${store.localFallback.base} when the runner has none.`
  }
  return `\`vite dev\` uses the configured \`${store.driver}\` driver.`
}

/** Lists the Blob stores with what `vite dev` uses for each, for `vitehub inspect definitions --kind blob`. */
function inspectBlobStores(blob: BlobViteRuntimeConfig["blob"], file: string): ViteHubDefinitionSummary[] {
  if (!blob) return []
  return Object.entries(blob.stores ?? { default: blob.store }).map(([name, store]) => ({
    fields: [{ label: "Development", value: describeDevelopmentStore(store) }],
    file,
    name,
    source: "blob config",
  }))
}

function serializeVirtualConfig(config: BlobViteRuntimeConfig): string {
  return [
    `export const hosting = ${JSON.stringify(config.hosting)};`,
    `export const blob = ${JSON.stringify(config.blob)};`,
    "export default { hosting, blob };",
  ].join("\n")
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

function mergeNitroCloudflareBlobOutput(config: object, nitro: Record<string, unknown>, blob: BlobOptions | undefined, cloudflareHost: boolean): Record<string, unknown> {
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
  const imagesBinding = cloudflareImagesBinding(resolveBlobViteConfig(blob, { hosting: "cloudflare" }).blob)
  const baseNitro = {
    ...nitro,
    cloudflare: { ...cloudflare, wrangler: { ...wrangler, compatibility_flags: compatibilityFlags, ...(imagesBinding && !wrangler.images ? { images: imagesBinding } : {}) } },
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

/** True when a store uses the `fs` driver, also as the local store of `vite dev`. Its signed links need the signed route. */
function hasLocalStore(blob: BlobViteRuntimeConfig["blob"]): boolean {
  if (!blob) return false
  return Object.values(blob.stores ?? { default: blob.store }).some(store => store.driver === "fs" || (store.driver === "cloudflare-r2" && Boolean(store.localFallback)))
}

/** Merges the generated Blob registrations into the Nitro config. */
function mergeNitroBlobConfig(value: unknown, serve: BlobServeConfig | undefined, cloudflare: boolean, root?: string, signedRoute = false): Record<string, unknown> {
  const nitro = cloneNitroConfig(value)
  const externals = cloneNitroConfig(nitro.externals)
  const inline = Array.isArray(externals.inline) ? externals.inline : []
  // Generated file imports and package imports must share Nitro's bundled runtime.
  nitro.externals = { ...externals, inline: externals.inline === true ? true : [...new Set([...inline, blobPackageName])] }
  const plugin = root ? resolve(root, generatedNitroBlobPlugin) : generatedNitroBlobPlugin
  const middleware = root ? resolve(root, generatedNitroBlobMiddleware) : generatedNitroBlobMiddleware
  const serveHandler = root ? resolve(root, generatedBlobServeRouteHandler) : generatedBlobServeRouteHandler
  nitro.plugins = Array.isArray(nitro.plugins)
    ? nitro.plugins.filter(entry => !isGeneratedNitroRegistration(entry, generatedNitroBlobPlugin))
    : []
  nitro.handlers = Array.isArray(nitro.handlers)
    ? nitro.handlers.filter(handler => !isGeneratedNitroRegistration(handler?.handler, generatedNitroBlobMiddleware) && handler?.route !== signedNitroRoute)
    : []
  const kit = createNitroServerKit(nitro)
  kit.addPlugin(plugin)
  if (cloudflare) kit.addHandler({ handler: middleware, middleware: true })
  // Only an `fs` store signs links to this route. A hosted store signs links to its provider.
  if (signedRoute) kit.addHandler({ handler: signedRouteModule, route: signedNitroRoute })
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
function renderNitroBlobPlugin(blob: BlobViteRuntimeConfig["blob"], cloudflare: boolean, workersModule = true, imageModule?: ImageModule, requestBodyLimit?: number): string {
  const cloudflareGlobals = cloudflare && workersModule
  const setters = [cloudflareGlobals ? "setActiveCloudflareEnv" : undefined, "setBlobRuntimeConfig", imageModule === "sharp" ? "setBlobSharpModule" : imageModule === "photon" ? "setBlobPhotonLoader" : undefined, requestBodyLimit === undefined ? undefined : "setBlobRequestBodyLimit"]
  return [
    cloudflareGlobals ? "import { env as vitehubEnv } from 'cloudflare:workers'" : undefined,
    cloudflare ? undefined : "import { blobConfig } from './runtime.mjs'",
    // A literal import lets Nitro bundle or trace sharp for image variants.
    imageModule === "sharp" ? "import * as vitehubSharp from 'sharp'" : undefined,
    `import { ${setters.filter(Boolean).join(", ")} } from ${JSON.stringify(runtimeStateModule)}`,
    "",
    cloudflare ? `const blobConfig = ${JSON.stringify(blob)}` : undefined,
    "",
    "export default function vitehubBlobPlugin() {",
    cloudflareGlobals ? "  setActiveCloudflareEnv(vitehubEnv)" : undefined,
    imageModule === "sharp" ? "  setBlobSharpModule(vitehubSharp)" : undefined,
    // A literal dynamic import lets Nitro bundle Photon and its WebAssembly module in a chunk that loads on the first variant.
    imageModule === "photon" ? "  setBlobPhotonLoader(() => import('@cf-wasm/photon'))" : undefined,
    "  setBlobRuntimeConfig(blobConfig)",
    requestBodyLimit === undefined ? undefined : `  setBlobRequestBodyLimit(${requestBodyLimit})`,
    "}",
    "",
  ].filter(line => typeof line === "string").join("\n")
}

type ImageModule = "photon" | "sharp"

// Under `vitehub()`, the dev server config names the deployment preset, and Nitro has none.
function devServerHost(config: object) {
  return getHostingProvider(resolveHost({ hosting: getDeploymentPreset(config), nitro: Reflect.get(config, "nitro") }))
}

// Keep sharp's existing node_modules-based auto detection independent of NODE_PATH, which pnpm scripts set.
function isPackageInstalled(root: string, name: string): boolean {
  for (let directory = resolve(root); ; directory = dirname(directory)) {
    if (existsSync(resolve(directory, "node_modules", name, "package.json"))) return true
    if (dirname(directory) === directory) return false
  }
}

/**
 * The image package that the generated Nitro plugin imports. An explicit `photon` transformer requires
 * `@cf-wasm/photon` on every host. Workers never import sharp. `auto` imports sharp when the project can resolve it,
 * and an explicit `sharp` transformer requires it.
 */
async function resolveImageModule(config: ResolvedConfig, root: string, blob: BlobViteRuntimeConfig["blob"], cloudflare: boolean, provider?: "cloudflare" | "vercel"): Promise<ImageModule | undefined> {
  if (!blob || blob.images === false) return undefined
  const transformer = blob.images?.transformer ?? "auto"
  if (transformer === "photon") {
    // Use the project's resolver, including Plug'n'Play, from the generated import's location.
    const entry = await config.createResolver()("@cf-wasm/photon", resolve(root, generatedNitroBlobPlugin)).catch(() => undefined)
    // Vite's missing optional-peer placeholder is a resolved ID, but cannot load Photon.
    if (entry && !entry.startsWith("__vite-optional-peer-dep:")) return "photon"
    throw blobErrorDiagnostics.BLOB_B0007({ message: "[vitehub] `blob.images.transformer` is \"photon\", but the project cannot resolve @cf-wasm/photon. Install it with: pnpm add @cf-wasm/photon" })
  }
  if (cloudflare || provider === "cloudflare") return undefined
  if (transformer !== "auto" && transformer !== "sharp") return undefined
  const installed = isPackageInstalled(root, "sharp")
  if (!installed && transformer === "sharp") {
    throw blobErrorDiagnostics.BLOB_B0005({ message: "[vitehub] `blob.images.transformer` is \"sharp\", but the project cannot resolve sharp. Install it with: pnpm add sharp" })
  }
  return installed ? "sharp" : undefined
}

function renderNitroBlobMiddleware(workersModule = true): string {
  return [
    ...(workersModule
      ? [
          "// @ts-ignore Cloudflare provides this virtual module at runtime.",
          "import { env as vitehubEnv } from 'cloudflare:workers'",
        ]
      : []),
    `import { getRequestCloudflareEnv, setActiveCloudflareEnv } from ${JSON.stringify(runtimeStateModule)}`,
    "",
    "export default function vitehubBlobMiddleware(event: Parameters<typeof getRequestCloudflareEnv>[0]) {",
    ...(workersModule
      ? ["  const env = getRequestCloudflareEnv(event) ?? (vitehubEnv as unknown as Record<string, unknown>)", "  setActiveCloudflareEnv(env)"]
      : [
          "  // A Node dev runner has no Cloudflare env. Keep the active env as it is.",
          "  const env = getRequestCloudflareEnv(event)",
          "  if (env) setActiveCloudflareEnv(env)",
        ]),
    "}",
    "",
  ].join("\n")
}

function renderBlobServeRouteHandler(serve: BlobServeConfig, importBase = blobPackageName, authorizeModule?: string): string {
  const headers = serve.headers && Object.keys(serve.headers).length > 0 ? serve.headers : undefined
  // Authorized objects belong to one user, so shared caches must not store them unless the app sets its own policy.
  const cacheControl = Object.entries(headers ?? {}).findLast(([name]) => name.toLowerCase() === "cache-control")?.[1]
    ?? (serve.authorize ? "private, no-cache" : "public, max-age=0, s-maxage=0")
  // A `:name` segment matches any one segment, like the Nitro route.
  const routeSegments = normalizeRoute(normalizeNitroRoute(serve.route)).split("/").filter(Boolean)
  return [
    `import { blob, parseImageVariant } from '${importBase}'`,
    ...(serve.authorize ? [`import { ${serve.anonymous ? "withAnonymousAuthorization" : "withAuthorization"} } from ${JSON.stringify(AUTH_SERVER_ID)}`] : []),
    ...(authorizeModule ? [`import { authorize } from ${JSON.stringify(authorizeModule)}`] : []),
    "",
    "type RouteRequest = Request & { context?: { params?: { _?: string } } }",
    "",
    `const storeName = ${JSON.stringify(serve.store)}`,
    `const routeSegments: string[] = ${JSON.stringify(routeSegments)}`,
    "",
    "// Nitro exposes its exact raw catch-all on the Request, including for root routes and a baseURL.",
    "// A direct Fetchable call has no router context and matches the configured route at the URL root.",
    "function blobPathname(request: RouteRequest, url: URL): string {",
    "  if (request.context?.params) return request.context.params._ ?? ''",
    "  const segments = url.pathname.split('/').slice(1)",
    "  if (routeSegments.every((segment, index) => segment.startsWith(':') ? Boolean(segments[index]) : segment === segments[index])) {",
    "    return segments.slice(routeSegments.length).join('/')",
    "  }",
    "  return ''",
    "}",
    "",
    "async function serveBlob(request: Request): Promise<Response> {",
    "  const response = await serveBlobResponse(request)",
    "  const { res } = (request as Request & { '~standard'?: { res: { headers?: Headers } } })['~standard'] ?? {}",
    "  if (response.status < 400) {",
    "    // H3 replaces the Response headers with the headers that middleware set. When Blob sets a CSP, such as the",
    "    // sandbox of an HTML or SVG file, this route writes the final CSP: the Blob CSP after a non-empty middleware CSP,",
    "    // as two policies that the browser applies both. A middleware CSP, also an empty one, cannot remove the sandbox.",
    "    const blobPolicy = response.headers.get('content-security-policy')",
    "    if (!res?.headers || !blobPolicy) return response",
    "    const appPolicy = res.headers.get('content-security-policy')",
    "    res.headers.delete('content-security-policy')",
    "    const headers = new Headers(response.headers)",
    "    headers.set('content-security-policy', appPolicy ? `${appPolicy}, ${blobPolicy}` : blobPolicy)",
    "    return new Response(response.body, { headers, status: response.status, statusText: response.statusText })",
    "  }",
    "  // H3 drops pending middleware headers for error Responses. Keep them, with the Blob headers taking precedence.",
    "  const headers = new Headers(res?.headers)",
    "  for (const [name, value] of response.headers) {",
    "    if (name !== 'set-cookie') headers.set(name, value)",
    "  }",
    "  for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie)",
    "  return new Response(request.method === 'HEAD' ? null : response.body, { headers, status: response.status, statusText: response.statusText })",
    "}",
    "",
    "async function serveBlobResponse(request: Request): Promise<Response> {",
    "  const url = new URL(request.url)",
    "  const pathname = blobPathname(request, url)",
    "  if (!pathname) return Response.json({ error: 'Blob not found.' }, { status: 404 })",
    "  // ?w=&h=&fit=&fmt=&q=&crop= selects an image variant. Invalid values are client errors.",
    `  const options: { variant?: NonNullable<ReturnType<typeof parseImageVariant>>, cacheControl: string, headers?: Record<string, string> } = { cacheControl: ${JSON.stringify(cacheControl)}${headers ? `, headers: ${JSON.stringify(headers)}` : ""} }`,
    "  try {",
    "    const variant = parseImageVariant(url.searchParams)",
    "    if (variant) options.variant = variant",
    "  }",
    "  catch (error) {",
    "    return Response.json({ error: error instanceof Error ? error.message : 'Invalid image variant' }, { status: 400 })",
    "  }",
    ...(serve.authorize
      ? [
          "  // H3 adds the headers that middleware set before this route over the returned Response. An authorized object",
          "  // belongs to one user, so drop an earlier Cache-Control and keep the private policy of this route.",
          "  const { res } = (request as Request & { '~standard'?: { res: { headers?: Headers } } })['~standard'] ?? {}",
          "  res?.headers?.delete('cache-control')",
        ]
      : []),
    // The Response of `serve()` has the final status and headers, also for a 304, a range, or a bad pathname.
    "  return blob.store(storeName).serve(request, pathname, options)",
    "}",
    "",
    ...(serve.authorize
      ? [
          "// Authorize before the store read and before conditional request handling.",
          serve.anonymous
            ? "export default { fetch: withAnonymousAuthorization(authorize, (request: Request) => serveBlob(request)) }"
            : `export default { fetch: withAuthorization(${authorizeModule ? "authorize" : "true"}, (request: Request) => serveBlob(request)) }`,
        ]
      : ["export default { fetch: serveBlob }"]),
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

const commonJSSyntax = /(?:[\s;]|^)(?:module\.exports\b|exports\.\w|require\s*\(|global\.\w)/m

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
  // Vite is an optional peer; load its parser only when the integration discovers a module.
  const { exportNames } = await import("@vite-hub/internal/build/scan-module")
  if (exportNames(source, file).includes("authorize")) return file
  if (!file.endsWith(".cts") && !file.endsWith(".cjs") && !commonJSSyntax.test(source)) return
  let commonJS = source
  if (file.endsWith(".cts")) {
    const { transformWithOxc } = await import("vite")
    commonJS = (await transformWithOxc(source, file, { lang: "ts" })).code
  }
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
  if (serve.anonymous && !authorizeModule) {
    throw blobErrorDiagnostics.BLOB_B0006({ message: "[vitehub] `blob.serve.anonymous` requires an `authorize` export in `server/blob.ts` to decide signed-out requests." })
  }
  return authorizeModule
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

async function refreshBlobGeneratedFiles(config: ResolvedConfig, root: string, blob: BlobViteRuntimeConfig["blob"], cloudflare: boolean, importBase = blobPackageName, provider?: "cloudflare" | "vercel", authorizeModule?: string, development = false, requestBodyLimit?: number): Promise<void> {
  const runtimeFile = resolve(root, generatedNitroBlobRuntime)
  const imageModule = await resolveImageModule(config, root, blob, cloudflare, provider)
  // Editors and type checks read the types after `nuxt prepare` too.
  await writeFileIfChanged(resolve(root, generatedBlobTypes), renderBlobStoreTypes(blob, importBase))
  // `nuxt prepare` replays the hooks as a build. No type reads these files, and a running dev server loads them.
  if (Reflect.get(config, VITEHUB_PREPARE) !== true) {
    await Promise.all([
      writeFileIfChanged(runtimeFile, renderBlobRuntimeModule(runtimeFile, blob, provider)),
      writeFileIfChanged(resolve(root, generatedNitroBlobPlugin), renderNitroBlobPlugin(blob, cloudflare, !development, imageModule, requestBodyLimit)),
      writeFileIfChanged(resolve(root, generatedNitroBlobMiddleware), renderNitroBlobMiddleware(!development)),
    ])
  }
  const serve = blob ? blob.serve : undefined
  if (!serve) return
  const file = resolve(root, generatedBlobServeRouteHandler)
  await writeFileIfChanged(file, renderBlobServeRouteHandler(serve, importBase, authorizeModule))
}

/** Declares the configured store names, so `blob.store()` rejects an unknown name at compile time. */
function renderBlobStoreTypes(blob: BlobViteRuntimeConfig["blob"], importBase: string): string {
  if (!blob) return "export {}\n"
  return [
    "export {}",
    "",
    `declare module ${JSON.stringify(importBase)} {`,
    "  interface BlobStoreRegistry {",
    ...Object.keys(blob.stores ?? { default: blob.store }).map(name => `    ${JSON.stringify(name)}: true`),
    "  }",
    "}",
    "",
  ].join("\n")
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

export function hubBlob(options?: BlobOptions, internalOptions: InternalBlobModuleOptions = {}): BlobVitePlugin {
  const importBase = internalOptions.importBase ?? blobPackageName
  let blob: BlobOptions | undefined = options
  let nitroCloudflare = false
  let rootDir = process.cwd()
  let runtimeConfig: BlobViteRuntimeConfig | undefined
  // Nuxt replays `config` with the host command, but its replayed resolved config has no `command`.
  let command: string | undefined
  let resolved: ResolvedConfig | undefined
  let siblingRuntime: BlobRuntimeContribution | undefined
  const presetDriver = () => typeof internalOptions.presetDriver === "function" ? internalOptions.presetDriver(blob) : internalOptions.presetDriver
  const siblingRuntimeGenerations = createProviderDeploymentOutputGenerationState()
  const getConfig = () => runtimeConfig ??= resolveBlobViteConfig(options)

  return {
    name: BLOB_VITE_PLUGIN_NAME,
    api: { getConfig },
    vitehub: {
      durability: () => {
        const config = getConfig().blob
        if (!config) return []
        const stores = Object.fromEntries(Object.entries({ default: config.store, ...config.stores }).map(([name, store]) => [name, { driver: store.driver, ...("base" in store && typeof store.base === "string" ? { base: store.base } : {}) }]))
        return [{ export: "blobDurability", input: { stores }, module: durabilityModuleFile(import.meta.url), primitive: "blob" }]
      },
      // The Console, `vitehub blob`, and agents run these.
      operations: [{ export: "blobOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).blobOperations, module: operationsModule }],
      cli: async () => {
        const { createBlobCliNamespaces } = await import(/* @vite-ignore */ "./cli.js")
        return {
          namespaces: createBlobCliNamespaces(),
          provision: [createBlobCloudflareProvisionStep(() => blob), createBlobVercelProvisionStep(() => blob)],
        }
      },
      inspect: () => ({
        definitions: [{
          kind: "blob",
          label: "Blob stores",
          list: () => inspectBlobStores(
            resolveBlobViteConfig(blob, { dev: true, presetDriver: presetDriver(), hosting: resolved ? devServerHost(resolved) : undefined }).blob,
            resolved?.configFile ? relative(rootDir, resolved.configFile) : "vite.config",
          ),
        }],
        resources: () => inspectBlobResources(blob, { hosting: nitroCloudflare ? "cloudflare" : undefined }),
      }),
    },
    config: {
      order: "pre",
      handler(config, env) {
        command = env.command
        blob = getResolvedFeatureOptions<BlobOptions>(config, "blob") ?? blob
        const configuredNitro = (config as { nitro?: unknown }).nitro
        const cloudflare = isNitroCloudflareHost(configuredNitro)
        const development = env.command === "serve"
        // Nitro copies its handlers in its own `config` hook. Resolve the dev stores here, so that a local store of
        // `vite dev` registers the signed route before Nitro starts. `configResolved` is too late for its router.
        const blobConfig = resolveBlobViteConfig(blob, { dev: development, presetDriver: presetDriver(), hosting: development ? devServerHost(config) : cloudflare ? "cloudflare" : undefined })
        const nitro = mergeNitroBlobConfig(
          configuredNitro,
          blobConfig.blob ? blobConfig.blob.serve : undefined,
          cloudflare,
          hasNitroConfigContext(config) ? resolveViteHubProjectRoot(config.root || process.cwd()) : undefined,
          hasLocalStore(blobConfig.blob),
        )
        const composedNitro = mergeNitroCloudflareBlobOutput(config, nitro, blob, cloudflare)
        ;(config as { nitro?: unknown }).nitro = composedNitro
        return installStandaloneOperationRpc(config, env?.command ?? "build", operationsModule)
      },
    },
    async configResolved(config) {
      resolved = config
      rootDir = resolveViteHubProjectRoot(config.root)
      blob = getResolvedFeatureOptions<BlobOptions>(config, "blob") ?? blob
      const configuredNitro = (config as { nitro?: unknown }).nitro
      const cloudflare = isNitroCloudflareHost(configuredNitro)
      nitroCloudflare = cloudflare
      const development = (config.command ?? command) === "serve"
      // In `vite dev`, a store stays local unless it sets `remote: true`.
      const blobConfig = resolveBlobViteConfig(blob, { dev: development, presetDriver: presetDriver(), hosting: development ? devServerHost(config) : cloudflare ? "cloudflare" : undefined })
      const nitro = mergeNitroBlobConfig(
        configuredNitro,
        blobConfig.blob ? blobConfig.blob.serve : undefined,
        cloudflare,
        rootDir,
        hasLocalStore(blobConfig.blob),
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
        config,
        rootDir,
        runtimeConfig.blob,
        cloudflare,
        importBase,
        provider,
        await resolveBlobServeAuthorizeModule(config, rootDir, runtimeConfig.blob ? runtimeConfig.blob.serve : undefined),
        development,
        development && devServerHost(config) === "vercel" ? vercelFunctionRequestBodyBytes : undefined,
      )
    },
    configureServer(server) {
      publishStandaloneOperationServer(server)
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
    load: {
      filter: { id: /^\0#vitehub\/blob\/config$/ },
      handler(id) {
        if (id === RESOLVED_BLOB_VIRTUAL_CONFIG_ID) {
          return serializeVirtualConfig(getConfig())
        }
      },
    },
    resolveId: {
      filter: { id: /^#vitehub\/blob\/config$/ },
      handler(id) {
        if (id === BLOB_VIRTUAL_CONFIG_ID) {
          return RESOLVED_BLOB_VIRTUAL_CONFIG_ID
        }
      },
    },
  }
}
