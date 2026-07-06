import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

import { shouldSkipViteProviderBuild } from "@vite-hub/internal/build/deployment-output"
import { getViteMode } from "@vite-hub/internal/build/mode"
import { copyVercelFunctionRuntimePackages } from "@vite-hub/internal/build/vercel-runtime-packages"
import { createNoExternalMerger, isServerEnvironment, mergeGeneratedViteHubWatchIgnored, resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"

import { createWorkspaceRegistryContents, discoverViteWorkspaceDefinitions } from "../../build/discovery.ts"
import { initializeWorkspaceAssetRegistry, refreshWorkspaceBuildState, syncWorkspaceBuildAssets } from "../../build/integration.ts"
import { workspaceSuffixPattern } from "../../build/workspace-config.ts"
import { createWorkspaceCliContributor } from "../../cli.ts"
import { normalizeWorkspaceOptions } from "../../config.ts"
import { normalizeWorkspaceDefinition } from "../../core/registry.ts"
import { installHostedWorkspaceRuntime } from "../../hosted.ts"
import { installHostedVercelBlobWorkspaceRuntime } from "../../hosted-vercel-blob.ts"
import { ensureWorkspaceDevToken, refreshWorkspaceDevToken, runWorkspaceDevCommand, validateWorkspaceDevToken, workspaceDevHeader, workspaceDevHeaderValue, workspaceDevRoute, workspaceDevTokenServerId } from "../../server.ts"

import type { HmrContext, Plugin, ResolvedConfig, UserConfig, ViteDevServer } from "vite"
import type { DiscoveredWorkspaceDefinition } from "../../build/discovery.ts"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { WorkspaceBuildState } from "../../build/integration.ts"
import type { ResolvedWorkspaceModuleOptions, WorkspaceModuleOptions } from "../../core/types.ts"
import type { WorkspaceDevTokenOptions } from "../../server.ts"

const WORKSPACE_PACKAGE_NAME = "@vite-hub/workspace"
const WORKSPACES_ID = "#vitehub/workspaces"
const WORKSPACE_PREFIX = "#vitehub/workspaces/"
const WORKSPACE_ASSETS_REGISTRY_ID = "#vitehub-workspace-assets-registry"
const WORKSPACE_REGISTRY_ID = "#vitehub-workspace-registry"
const RESOLVED_WORKSPACES_ID = `\0${WORKSPACES_ID}`
const RESOLVED_WORKSPACE_PREFIX = `\0${WORKSPACE_PREFIX}`
const RESOLVED_WORKSPACE_REGISTRY_ID = `\0${WORKSPACE_REGISTRY_ID}`
const generatedNitroWorkspacePlugin = ".vitehub/nitro/workspace/plugin.ts"
const generatedNitroWorkspaceRegistry = ".vitehub/nitro/workspace/registry.js"
const mergeNoExternal = createNoExternalMerger(WORKSPACE_PACKAGE_NAME)
const workspacesDirSegment = /[\\/](?:server[\\/])?workspaces(?:[\\/]|$)/

function hasVercelBlobWorkspaceDefinition(definitions: DiscoveredWorkspaceDefinition[]): boolean {
  return definitions.some((definition) => {
    if (!definition.source) return false
    return /\bprovider\s*:\s*["']vercel-blob["']/.test(definition.source)
  })
}

function vercelFunctionRuntimePackages(options: false | ResolvedWorkspaceModuleOptions, definitions: DiscoveredWorkspaceDefinition[] = []) {
  const hasVercelBlobStore = (options && options.store?.provider === "vercel-blob") || hasVercelBlobWorkspaceDefinition(definitions)
  return [
    { name: WORKSPACE_PACKAGE_NAME, resolveFrom: import.meta.url },
    ...(hasVercelBlobStore ? [{ name: "@vercel/blob" }] : []),
  ]
}

export interface WorkspaceNitroConfigOptions {
  command?: "build" | "serve"
  env?: Record<string, string | undefined>
  hosting?: string
  nitro?: unknown
  viteRoot?: string
  workspace?: false | WorkspaceModuleOptions
}

export type NitroConfig = {
  plugins?: unknown[]
} & Record<string, unknown>

type ViteConfigWithWorkspaceNitro = Omit<UserConfig, "plugins"> & {
  nitro?: NitroConfig
}

type WorkspacePluginRoots = {
  projectRoot: string
  viteRoot: string
}

function mergeDedupe(current: string[] | undefined): string[] {
  if (!current) return [WORKSPACE_PACKAGE_NAME]
  return current.includes(WORKSPACE_PACKAGE_NAME) ? current : [...current, WORKSPACE_PACKAGE_NAME]
}

function isWorkspaceFile(file: string) {
  return workspaceSuffixPattern.test(file) || workspacesDirSegment.test(file)
}

function resolveWorkspacePluginRoots(root: string, workspaceOptions: false | WorkspaceModuleOptions | undefined): WorkspacePluginRoots {
  const resolvedViteRoot = resolve(root)
  const resolvedProjectRoot = resolveViteHubProjectRoot(resolvedViteRoot, {
    projectRoot: workspaceOptions ? workspaceOptions.projectRoot : undefined,
  })
  return { projectRoot: resolvedProjectRoot, viteRoot: resolvedViteRoot }
}

function discoverDefinitions(roots: WorkspacePluginRoots) {
  return discoverViteWorkspaceDefinitions(roots.viteRoot, { serverRootDir: roots.projectRoot })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isWorkspaceRegistry(value: unknown): value is Record<string, () => Promise<{ default?: unknown }>> {
  return isRecord(value) && Object.values(value).every(item => typeof item === "function")
}

function isHostedWorkspaceStore(store: ResolvedWorkspaceModuleOptions["store"]): boolean {
  return store.provider === "cloudflare-artifacts" || store.provider === "github" || store.provider === "vercel-blob"
}

function requestOrigin(server: ViteDevServer, req: IncomingMessage): string {
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
  if (host) {
    const fallback = server.resolvedUrls?.local?.[0] || "http://localhost/"
    return new URL(`${new URL(fallback).protocol}//${host}`).origin
  }
  const base = server.resolvedUrls?.local?.[0] || `http://localhost:${server.config.server.port || 5173}/`
  return new URL(base).origin
}

function validateWorkspaceDevRequest(server: ViteDevServer, req: IncomingMessage): Response | undefined {
  const header = req.headers[workspaceDevHeader]
  if ((Array.isArray(header) ? header[0] : header) !== workspaceDevHeaderValue) {
    return new Response("Forbidden Workspace Dev request.", { status: 403 })
  }
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
  if (origin && origin !== requestOrigin(server, req)) {
    return new Response("Forbidden Workspace Dev origin.", { status: 403 })
  }
  if (req.method !== "POST") return
  const contentType = Array.isArray(req.headers["content-type"]) ? req.headers["content-type"][0] : req.headers["content-type"]
  if (!contentType?.toLowerCase().startsWith("application/json")) {
    return new Response("Workspace Dev requests must use application/json.", { status: 415 })
  }
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = ""
  req.setEncoding("utf8")
  for await (const chunk of req) body += chunk
  return body
}

function createAbortSignalFromClose(target: Pick<ServerResponse, "off" | "once">, message: string): { dispose: () => void, signal: AbortSignal } {
  const controller = new AbortController()
  const abort = () => controller.abort(new Error(message))
  target.once("close", abort)
  return {
    dispose: () => target.off("close", abort),
    signal: controller.signal,
  }
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  for (const [name, value] of response.headers) res.setHeader(name, value)
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
    res.end()
  }
  finally {
    reader.releaseLock()
  }
}

function isWorkspaceDevRoute(req: IncomingMessage): boolean {
  return new URL(req.url || "/", "http://localhost").pathname === workspaceDevRoute
}

async function handleWorkspaceDevRequest(server: ViteDevServer, req: IncomingMessage, workspaces: Array<{ name: string }>, tokenOptions: WorkspaceDevTokenOptions, abortSignal?: AbortSignal): Promise<Response> {
  const validation = validateWorkspaceDevRequest(server, req)
  if (validation) return validation
  if (req.method === "GET") {
    await ensureWorkspaceDevToken(server.config.root, tokenOptions)
    return Response.json({
      root: server.config.root,
      workspaceDevTokenServerId: tokenOptions.serverId,
      workspaces,
    })
  }
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 })

  let body: { workspaceCommand?: { args?: unknown, command?: unknown, paths?: unknown, timeout?: unknown, workspace?: unknown } }
  try {
    body = JSON.parse(await readRequestBody(req)) as typeof body
  }
  catch {
    return new Response("Malformed Workspace Dev payload.", { status: 400 })
  }
  const command = body.workspaceCommand
  if (!command || typeof command.workspace !== "string" || typeof command.command !== "string") {
    return new Response("Missing Workspace Dev command.", { status: 400 })
  }
  if (!await validateWorkspaceDevToken(server.config.root, req.headers, tokenOptions)) {
    return new Response("Forbidden Workspace Dev token.", { status: 403 })
  }
  const mod = await server.ssrLoadModule(WORKSPACE_REGISTRY_ID) as { default?: unknown }
  const registry = isWorkspaceRegistry(mod.default) ? mod.default : {}
  const load = registry[command.workspace]
  if (!load) return new Response(`Unknown Workspace Dev target: ${command.workspace}`, { status: 404 })
  const definition = (await load()).default
  if (command.args !== undefined && (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== "string"))) {
    return new Response("Workspace Dev command args must be strings.", { status: 400 })
  }
  if (command.paths !== undefined && (!Array.isArray(command.paths) || command.paths.some(path => typeof path !== "string"))) {
    return new Response("Workspace Dev command paths must be strings.", { status: 400 })
  }
  const args = command.args as string[] | undefined
  const paths = command.paths as string[] | undefined
  const timeout = typeof command.timeout === "number" && Number.isFinite(command.timeout) ? command.timeout : undefined
  return Response.json(await runWorkspaceDevCommand({
    abortSignal,
    ...(args ? { args } : {}),
    command: command.command,
    ...(isRecord(definition) ? { definition: normalizeWorkspaceDefinition(command.workspace, definition as never) } : {}),
    ...(paths?.length ? { paths } : {}),
    ...(timeout ? { timeout } : {}),
    workspace: command.workspace,
  }))
}

function hasNitroPlugin(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasNitroPlugin)
  return isRecord(value) && typeof value.name === "string" && value.name.startsWith("nitro:")
}

function hasNitroConfig(config: UserConfig): boolean {
  return "nitro" in config || hasNitroPlugin(config.plugins)
}

function hasExplicitWorkspaceRuntimeOptions(options: false | WorkspaceModuleOptions | undefined): boolean {
  return Boolean(options && (options.root || options.store))
}

function shouldInstallNitroWorkspacePlugin(
  config: UserConfig,
  options: false | WorkspaceModuleOptions | undefined,
  normalized: ResolvedWorkspaceModuleOptions,
  definitions: DiscoveredWorkspaceDefinition[],
): boolean {
  return isHostedWorkspaceStore(normalized.store)
    || hasExplicitWorkspaceRuntimeOptions(options)
    || (hasNitroConfig(config) && definitions.length > 0)
}

function mergeNitroWorkspaceConfig(value: unknown): NitroConfig {
  const nitro: NitroConfig = isRecord(value) ? { ...value } : {}
  const plugins = Array.isArray(nitro.plugins) ? [...nitro.plugins] : []
  if (!plugins.includes(generatedNitroWorkspacePlugin)) plugins.push(generatedNitroWorkspacePlugin)
  return { ...nitro, plugins }
}

function moduleImportSpecifier(fromFile: string, targetFile: string): string {
  const specifier = relative(dirname(fromFile), targetFile).replace(/\\/g, "/")
  return specifier.startsWith(".") ? specifier : `./${specifier}`
}

function shouldConfigureRuntime(options: false | WorkspaceModuleOptions | undefined, normalized: ResolvedWorkspaceModuleOptions): boolean {
  return isHostedWorkspaceStore(normalized.store) || hasExplicitWorkspaceRuntimeOptions(options)
}

function renderRuntimeValue(value: unknown, depth = 0): string {
  if (typeof value === "function") return value.toString()
  if (Array.isArray(value)) {
    if (!value.length) return "[]"
    const indent = "  ".repeat(depth + 1)
    const closingIndent = "  ".repeat(depth)
    return `[\n${value.map(item => `${indent}${renderRuntimeValue(item, depth + 1)}`).join(",\n")}\n${closingIndent}]`
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
    if (!entries.length) return "{}"
    const indent = "  ".repeat(depth + 1)
    const closingIndent = "  ".repeat(depth)
    return `{\n${entries.map(([key, entry]) => `${indent}${JSON.stringify(key)}: ${renderRuntimeValue(entry, depth + 1)}`).join(",\n")}\n${closingIndent}}`
  }
  return JSON.stringify(value)
}

function runtimeWorkspaceConfig(config: false | ResolvedWorkspaceModuleOptions, options: false | WorkspaceModuleOptions | undefined): false | ResolvedWorkspaceModuleOptions {
  if (!config || config.store.provider !== "github" || !options) return config
  const store = options.store
  if (!store || "readFile" in store || store.provider !== "github") return config
  const runtimeStore = { ...config.store }
  for (const key of ["branch", "repo", "repository", "root", "token"] as const) {
    if (typeof store[key] === "function") {
      runtimeStore[key] = store[key]
    }
  }
  return { ...config, store: runtimeStore }
}

function renderNitroWorkspacePlugin(config: false | ResolvedWorkspaceModuleOptions, registryImport: string, installHostedRuntime: boolean): string {
  const hostedConfig = config && isHostedWorkspaceStore(config.store) ? config : undefined
  const isVercelBlobStore = hostedConfig?.store.provider === "vercel-blob"
  const runtimeImports = hostedConfig
    ? [
        isVercelBlobStore
          ? "import { configureHostedVercelBlobWorkspaceRuntime } from '@vite-hub/workspace/internal/runtime/hosted-vercel-blob'"
          : "import { configureHostedWorkspaceRuntime, installHostedWorkspaceRuntime } from '@vite-hub/workspace/internal/runtime/hosted'",
        isVercelBlobStore
          ? "import { installHostedWorkspaceRuntime } from '@vite-hub/workspace/internal/runtime/hosted'"
          : "import { installHostedVercelBlobWorkspaceRuntime } from '@vite-hub/workspace/internal/runtime/hosted-vercel-blob'",
        "import { setWorkspaceRuntimeRegistry } from '@vite-hub/workspace/runtime'",
      ]
    : [
        ...(installHostedRuntime ? ["import { installHostedWorkspaceRuntime } from '@vite-hub/workspace/internal/runtime/hosted'"] : []),
        ...(installHostedRuntime ? ["import { installHostedVercelBlobWorkspaceRuntime } from '@vite-hub/workspace/internal/runtime/hosted-vercel-blob'"] : []),
        `import { ${config ? "setWorkspaceRuntimeConfig, " : ""}setWorkspaceRuntimeRegistry } from '@vite-hub/workspace/runtime'`,
      ]
  const runtimeSetup = hostedConfig
    ? [
        `  ${isVercelBlobStore ? "configureHostedVercelBlobWorkspaceRuntime" : "configureHostedWorkspaceRuntime"}(${renderRuntimeValue({ root: hostedConfig.root, store: hostedConfig.store })})`,
        `  ${isVercelBlobStore ? "installHostedWorkspaceRuntime" : "installHostedVercelBlobWorkspaceRuntime"}()`,
      ]
    : [
        ...(installHostedRuntime ? ["  installHostedWorkspaceRuntime()"] : []),
        ...(installHostedRuntime ? ["  installHostedVercelBlobWorkspaceRuntime()"] : []),
        ...(config ? [`  setWorkspaceRuntimeConfig(${renderRuntimeValue({ root: config.root, store: config.store })})`] : []),
      ]

  return [
    ...runtimeImports,
    `import registry from ${JSON.stringify(registryImport)}`,
    "",
    "export default function vitehubWorkspacePlugin() {",
    "  setWorkspaceRuntimeRegistry(registry)",
    ...runtimeSetup,
    "}",
    "",
  ].join("\n")
}

async function writeNitroWorkspacePlugin(root: string, config: false | ResolvedWorkspaceModuleOptions, options: false | WorkspaceModuleOptions | undefined, definitions: DiscoveredWorkspaceDefinition[]): Promise<void> {
  const pluginFile = resolve(root, generatedNitroWorkspacePlugin)
  const registryFile = resolve(root, generatedNitroWorkspaceRegistry)
  const runtimeConfig = runtimeWorkspaceConfig(config, options)
  await Promise.all([
    mkdir(dirname(pluginFile), { recursive: true }),
    mkdir(dirname(registryFile), { recursive: true }),
  ])
  await writeFile(registryFile, createWorkspaceRegistryContents(registryFile, definitions), "utf8")
  await writeFile(
    pluginFile,
    renderNitroWorkspacePlugin(runtimeConfig, moduleImportSpecifier(pluginFile, registryFile), definitions.length > 0 && !(runtimeConfig && isHostedWorkspaceStore(runtimeConfig.store))),
    "utf8",
  )
}

export async function createWorkspaceNitroConfig(options: WorkspaceNitroConfigOptions = {}): Promise<NitroConfig | null> {
  const workspaceOptions = options.workspace
  const roots = resolveWorkspacePluginRoots(options.viteRoot || process.cwd(), workspaceOptions)
  const normalized = normalizeWorkspaceOptions(workspaceOptions, {
    dev: options.command !== "build",
    env: options.env || process.env,
    hosting: options.hosting ?? process.env.VITEHUB_HOSTING,
    rootDir: roots.projectRoot,
  })
  if (!normalized) return null

  const definitions = discoverDefinitions(roots)
  if (!isHostedWorkspaceStore(normalized.store) && !hasExplicitWorkspaceRuntimeOptions(workspaceOptions) && definitions.length === 0) return null

  const runtimeConfig = shouldConfigureRuntime(workspaceOptions, normalized) ? normalized : false
  await writeNitroWorkspacePlugin(roots.projectRoot, runtimeConfig, workspaceOptions, definitions)
  return mergeNitroWorkspaceConfig(options.nitro)
}

export interface WorkspaceVitePluginAPI {
  getWorkspaces: () => Array<{ name: string }>
}

interface WorkspaceCliContributingPlugin {
  vitehub?: { cli?: () => unknown | Promise<unknown> }
}

export type WorkspaceVitePlugin = Plugin & WorkspaceCliContributingPlugin & { api: WorkspaceVitePluginAPI }

export function hubWorkspace(options?: WorkspaceModuleOptions): WorkspaceVitePlugin {
  let resolved: ResolvedConfig | undefined
  let resolvedOptions: ReturnType<typeof normalizeWorkspaceOptions> = false
  let projectRoot: string | undefined
  let viteRoot: string | undefined
  let assetsRegistryFile: string | undefined
  let manifest: WorkspaceBuildState["manifest"] = { workspaces: [] }
  let registryContents = "export default {}\n"
  let server: ViteDevServer | undefined

  async function refreshManifest(roots: WorkspacePluginRoots) {
    const definitions = discoverDefinitions(roots)
    const state = await refreshWorkspaceBuildState(roots.projectRoot, definitions)
    manifest = state.manifest
    registryContents = state.registryContents
  }

  function invalidateVirtualWorkspaceModules() {
    if (!server) return
    const moduleGraph = server.moduleGraph
    const ids = [RESOLVED_WORKSPACE_REGISTRY_ID, RESOLVED_WORKSPACES_ID, ...manifest.workspaces.map(w => `${RESOLVED_WORKSPACE_PREFIX}${w.name}`)]
    for (const id of ids) {
      const mod = moduleGraph.getModuleById(id)
      if (mod) moduleGraph.invalidateModule(mod)
    }
  }

  async function maybeRefreshTypesForFile(roots: WorkspacePluginRoots, file: string) {
    if (!isWorkspaceFile(file)) return
    await refreshManifest(roots)
    invalidateVirtualWorkspaceModules()
  }

  return {
    name: "@vite-hub/workspace/vite",
    enforce: "pre",
    api: {
      getWorkspaces: () => manifest.workspaces,
    },
    async config(config, env) {
      const workspaceOptions = (config as UserConfig & { workspace?: false | WorkspaceModuleOptions }).workspace ?? options
      const roots = resolveWorkspacePluginRoots(config.root || process.cwd(), workspaceOptions)
      const normalized = normalizeWorkspaceOptions(workspaceOptions, {
        dev: env?.command !== "build",
        env: process.env,
        hosting: process.env.VITEHUB_HOSTING,
        rootDir: roots.projectRoot,
      })
      const viteConfig: ViteConfigWithWorkspaceNitro = {
        server: {
          watch: {
            ignored: mergeGeneratedViteHubWatchIgnored(config.server?.watch?.ignored),
          },
        },
      }
      const definitions = normalized ? discoverDefinitions(roots) : []
      if (normalized && shouldInstallNitroWorkspacePlugin(config, workspaceOptions, normalized, definitions)) {
        const runtimeConfig = shouldConfigureRuntime(workspaceOptions, normalized) ? normalized : false
        await writeNitroWorkspacePlugin(roots.projectRoot, runtimeConfig, workspaceOptions, definitions)
        const nitro = mergeNitroWorkspaceConfig((config as ViteConfigWithWorkspaceNitro).nitro)
        ;(config as ViteConfigWithWorkspaceNitro).nitro = nitro
        viteConfig.nitro = nitro
      }
      return viteConfig
    },
    async configResolved(config) {
      resolved = config
      const workspaceOptions = (config as ResolvedConfig & { workspace?: false | WorkspaceModuleOptions }).workspace ?? options
      const roots = resolveWorkspacePluginRoots(config.root, workspaceOptions)
      projectRoot = roots.projectRoot
      viteRoot = roots.viteRoot
      if (config.command !== "build")
        process.env.VITEHUB_WORKSPACE_DEV = "true"
      else
        delete process.env.VITEHUB_WORKSPACE_DEV
      resolvedOptions = normalizeWorkspaceOptions(workspaceOptions, {
        dev: config.command !== "build",
        env: process.env,
        hosting: process.env.VITEHUB_HOSTING,
        rootDir: roots.projectRoot,
      })
      assetsRegistryFile = resolve(roots.projectRoot, ".vitehub/vite-runtime/workspace/assets/registry.mjs")
      await initializeWorkspaceAssetRegistry(assetsRegistryFile)
      await refreshManifest(roots)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: {
          dedupe: mergeDedupe(config.resolve?.dedupe),
          noExternal: mergeNoExternal(config.resolve?.noExternal),
        },
      }
    },
    async buildStart() {
      if (!resolved) return
      const roots = {
        projectRoot: projectRoot || resolveViteHubProjectRoot(resolved.root),
        viteRoot: viteRoot || resolve(resolved.root),
      }
      await refreshManifest(roots)
      if (resolved.command !== "build" || !assetsRegistryFile) return

      const definitions = discoverDefinitions(roots)
      await syncWorkspaceBuildAssets(definitions, roots.projectRoot, resolvedOptions, assetsRegistryFile)
    },
    closeBundle: {
      order: "post",
      async handler() {
        if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
        const roots = {
          projectRoot: projectRoot || resolveViteHubProjectRoot(resolved.root),
          viteRoot: viteRoot || resolve(resolved.root),
        }
        const definitions = discoverDefinitions(roots)
        await Promise.all(definitions.map(async (definition) => {
          definition.source = await readFile(definition.path, "utf8")
        }))
        await copyVercelFunctionRuntimePackages({
          packages: vercelFunctionRuntimePackages(resolvedOptions, definitions),
          rootDir: roots.projectRoot,
        })
      },
    },
    async configureServer(devServer) {
      server = devServer
      installHostedWorkspaceRuntime()
      installHostedVercelBlobWorkspaceRuntime()
      const tokenOptions = { serverId: workspaceDevTokenServerId(devServer.config.server.port) }
      await refreshWorkspaceDevToken(devServer.config.root, tokenOptions)
      const roots = {
        projectRoot: projectRoot || resolveViteHubProjectRoot(devServer.config.root),
        viteRoot: viteRoot || resolve(devServer.config.root),
      }
      const refresh = async (file: string) => await maybeRefreshTypesForFile(roots, file)
      devServer.watcher.on("add", refresh)
      devServer.watcher.on("unlink", refresh)
      devServer.middlewares.use((req, res, next) => {
        if (!isWorkspaceDevRoute(req)) return next()
        const abort = createAbortSignalFromClose(res, "[vitehub] Workspace Dev response closed.")
        void handleWorkspaceDevRequest(devServer, req, manifest.workspaces, tokenOptions, abort.signal)
          .then(response => writeResponse(res, response))
          .catch((error: unknown) => writeResponse(res, new Response(error instanceof Error ? error.message : "Workspace Dev request failed.", { status: 500 })))
          .finally(abort.dispose)
      })
    },
    vitehub: {
      cli: async () => {
        return createWorkspaceCliContributor()
      },
    },
    async handleHotUpdate(ctx: HmrContext) {
      if (!resolved) return
      await maybeRefreshTypesForFile({
        projectRoot: projectRoot || resolveViteHubProjectRoot(resolved.root),
        viteRoot: viteRoot || resolve(resolved.root),
      }, ctx.file)
    },
    resolveId(id) {
      if (id === WORKSPACE_ASSETS_REGISTRY_ID) return assetsRegistryFile
      if (id === WORKSPACE_REGISTRY_ID) return RESOLVED_WORKSPACE_REGISTRY_ID
      if (id === WORKSPACES_ID) return RESOLVED_WORKSPACES_ID
      if (id.startsWith(WORKSPACE_PREFIX)) return `${RESOLVED_WORKSPACE_PREFIX}${id.slice(WORKSPACE_PREFIX.length)}`
    },
    load(id) {
      if (id === RESOLVED_WORKSPACE_REGISTRY_ID) return registryContents
      if (id === RESOLVED_WORKSPACES_ID) {
        return `export const workspaces = ${JSON.stringify(manifest.workspaces)};\nexport default { workspaces };\n`
      }
      if (id.startsWith(RESOLVED_WORKSPACE_PREFIX)) {
        const name = id.slice(RESOLVED_WORKSPACE_PREFIX.length)
        const workspace = manifest.workspaces.find(item => item.name === name)
        return `const manifest = ${JSON.stringify(workspace ? { ...workspace, entries: [] } : { name, entries: [] })};\nexport default manifest;\n`
      }
    },
  }
}

declare module "vite" {
  interface UserConfig {
    workspace?: false | WorkspaceModuleOptions
  }
}
