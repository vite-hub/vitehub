import { readFile } from "node:fs/promises"
import { dirname, extname, relative, resolve } from "node:path"

import { createDefaultCloudflareOutputRoot, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { writeFileIfChanged, writeFileIfChangedSync } from "@vite-hub/internal/definition-catalog"
import { copyVercelFunctionRuntimePackages } from "@vite-hub/internal/build/vercel-runtime-packages"
import { ownModule } from "@vite-hub/internal/build/paths"
import { createNoExternalAddition, isServerEnvironment, generatedViteHubWatchIgnoredAddition, loadNativePackageModule, loadsViteHubPackagesNatively, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { registerViteHubDevEndpoint } from "@vite-hub/internal/dev-endpoint"
import { createNitroServerKit, mergeNitroExternal } from "@vite-hub/internal/nitro-kit"
import { getHostingProvider, resolveHostPreset } from "@vite-hub/internal/hosting"

import { createWorkspaceDefinitionLoader, loadDiscoveredWorkspaceDefinition, resolveWorkspaceDefinitionModule } from "../../build/assets.ts"
import { collectWorkspaceContributions } from "../../build/contributions.ts"
import { createWorkspaceRegistryContents, discoverViteWorkspaceDefinitions } from "../../build/discovery.ts"
import { initializeWorkspaceAssetRegistry, refreshWorkspaceBuildState, syncWorkspaceBuildAssets } from "../../build/integration.ts"
import { workspaceSuffixPattern } from "../../build/workspace-config.ts"
import { createWorkspaceCliContributor } from "../../cli.ts"
import { normalizeWorkspaceOptions } from "../../config.ts"
import { workspaceOperations } from "../../operations.ts"
import { normalizeWorkspaceDefinition } from "../../core/registry.ts"
import { installHostedWorkspaceRuntime } from "../../hosted.ts"
import { installHostedVercelBlobWorkspaceRuntime } from "../../hosted-vercel-blob.ts"
import { inspectWorkspaceDefinitions } from "../../inspect.ts"
import { configureCloudflareArtifacts } from "../../integrations/cloudflare.ts"
import { ensureWorkspaceDevToken, refreshWorkspaceDevToken, runWorkspaceDevCommand, validateWorkspaceDevToken, workspaceDevHeader, workspaceDevHeaderValue, workspaceDevRoute, workspaceDevTokenServerId } from "../../server.ts"
import { isWorkspaceStore } from "../../storage/provider.ts"

import type { AliasOptions, HmrContext, Plugin, ResolvedConfig, UserConfig, ViteDevServer } from "vite"
import type { DurabilityPluginMetadata } from "@vite-hub/internal/durability"
import type { CloudflareProviderDeploymentOutputStateReader, ProviderDeploymentOutputWriter } from "@vite-hub/internal/build/deployment-output"
import type { CollectedWorkspaceContribution } from "../../build/contributions.ts"
import type { DiscoveredWorkspaceDefinition } from "../../build/discovery.ts"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { WorkspaceBuildState } from "../../build/integration.ts"
import type { ResolvedWorkspaceModuleOptions, WorkspaceDefinitionInput, WorkspaceOptions } from "../../core/types.ts"
import type { WorkspaceDevTokenOptions } from "../../server.ts"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { OperationContributionEntry } from "@vite-hub/internal/operations"
import { workspaceErrorDiagnostics } from "../../error-diagnostics.ts"

const WORKSPACE_PACKAGE_NAME = "@vite-hub/workspace"
const WORKSPACES_ID = "#vitehub/workspaces"
const WORKSPACE_PREFIX = "#vitehub/workspaces/"
const WORKSPACE_ASSETS_REGISTRY_ID = "#vitehub-workspace-assets-registry"
const workspaceAssetsRegistryPath = ".vitehub/vite-runtime/workspace/assets/registry.mjs"
const WORKSPACE_REGISTRY_ID = "#vitehub-workspace-registry"
const RESOLVED_WORKSPACES_ID = `\0${WORKSPACES_ID}`
const RESOLVED_WORKSPACE_PREFIX = `\0${WORKSPACE_PREFIX}`
const RESOLVED_WORKSPACE_REGISTRY_ID = `\0${WORKSPACE_REGISTRY_ID}`
// Skip unrelated ids while retaining native package loading in the Nitro dev environment.
const WORKSPACE_ID_PATTERN = /^#vitehub(?:-workspace-(?:assets-)?registry$|\/workspaces(?:$|\/))/
// The native loader decodes file: URLs before checking their package paths.
const WORKSPACE_LOAD_ID_PATTERN = /(?:^\0#vitehub(?:-workspace-registry$|\/workspaces(?:$|\/))|^file:|[/\\]node_modules[/\\]@vite-hub[/\\](?:agent|connections|runtime|workspace)[/\\]dist[/\\].+\.js$)/
const generatedNitroWorkspacePlugin = ".vitehub/nitro/workspace/plugin.ts"
const generatedNitroWorkspaceRegistry = ".vitehub/nitro/workspace/registry.js"
const generatedNitroWorkspaceDurabilityRegistry = ".vitehub/nitro/workspace/durability-registry.js"
const cloudflareArtifactsBindingsFileName = ".vitehub-workspace-artifacts-bindings.json"
const noExternalAddition = createNoExternalAddition(WORKSPACE_PACKAGE_NAME)
const workspacesDirSegment = /[\\/](?:server[\\/])?workspaces(?:[\\/]|$)/

const sourceModuleExtensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"]

async function readSourceModule(file: string): Promise<{ file: string, source: string } | undefined> {
  const candidates = extname(file)
    ? [file]
    : [
        ...sourceModuleExtensions.map(extension => `${file}${extension}`),
        ...sourceModuleExtensions.map(extension => resolve(file, `index${extension}`)),
      ]
  for (const candidate of candidates) {
    try {
      return { file: candidate, source: await readFile(candidate, "utf8") }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}

interface BabelNode {
  arguments?: BabelNode[]
  callee?: BabelNode
  computed?: boolean
  declaration?: BabelNode
  expression?: BabelNode
  imported?: BabelNode
  key?: { name?: unknown, type?: string, value?: unknown }
  kind?: string
  name?: string
  properties?: BabelNode[]
  source?: BabelNode
  type?: string
  value?: BabelNode | unknown
}

interface BabelNodePath {
  node: BabelNode
  parentPath?: BabelNodePath
  scope: { getBinding: (name: string) => { path: BabelNodePath } | undefined }
}

function vercelFunctionRuntimePackages() {
  return [
    { name: WORKSPACE_PACKAGE_NAME, resolveFrom: import.meta.url },
  ]
}

type CloudflareArtifactsWranglerConfig = {
  artifacts: Array<{ binding: string, namespace: string }>
}

type ConfiguredCloudflareArtifact = Record<string, unknown> & { binding: string }

function hasCloudflareArtifactBinding(value: unknown): value is ConfiguredCloudflareArtifact {
  return isRecord(value) && typeof value.binding === "string"
}

function configuredCloudflareArtifacts(wranglerConfig: unknown): ConfiguredCloudflareArtifact[] {
  if (!isRecord(wranglerConfig) || !Array.isArray(wranglerConfig.artifacts)) return []
  return wranglerConfig.artifacts.filter(hasCloudflareArtifactBinding)
}

function createCloudflareArtifactsWranglerConfig(configs: ResolvedWorkspaceModuleOptions[]): CloudflareArtifactsWranglerConfig | undefined {
  const target: { cloudflare?: { wrangler?: { artifacts?: Array<{ binding: string, namespace: string }> } } } = {}
  for (const config of configs) configureCloudflareArtifacts(target, config)
  const artifacts = target.cloudflare?.wrangler?.artifacts
  return artifacts?.length ? { artifacts } : undefined
}

function resolveOwnedCloudflareArtifacts(
  requested: CloudflareArtifactsWranglerConfig["artifacts"],
  configured: ConfiguredCloudflareArtifact[],
  previousBindings: string[],
): CloudflareArtifactsWranglerConfig["artifacts"] {
  const previous = new Set(previousBindings)
  return requested.filter((artifact) => {
    if (previous.has(artifact.binding)) return true
    const existing = configured.filter(entry => entry.binding === artifact.binding)
    const collision = existing.find(entry => entry.namespace !== artifact.namespace)
    if (collision) {
      throw workspaceErrorDiagnostics.WORKSPACE_R0027({ message: `[vitehub] Cloudflare Artifacts binding "${artifact.binding}" already exists in Wrangler config with namespace ${JSON.stringify(collision.namespace)}, but Workspace requested namespace "${artifact.namespace}". Configure a unique binding or use the existing namespace.` })
    }
    return existing.length === 0
  })
}

function unwrapBabelExpression(node: BabelNode | undefined): BabelNode | undefined {
  if (node?.type === "TSAsExpression" || node?.type === "TSSatisfiesExpression" || node?.type === "TSTypeAssertion") {
    return unwrapBabelExpression(node.expression)
  }
  return node
}

function babelCallsWorkspaceImport(node: BabelNode | undefined, path: BabelNodePath, name: string, entry = ""): boolean {
  if (node?.type !== "CallExpression" || node.callee?.type !== "Identifier" || !node.callee.name) return false
  const binding = path.scope.getBinding(node.callee.name)?.path
  return binding?.node.type === "ImportSpecifier"
    && binding.node.imported?.name === name
    && [
      `@vite-hub/workspace${entry}`,
      `vite-hub/workspace${entry}`,
    ].includes(String(binding.parentPath?.node.source?.value))
}

function babelStaticObjectProperties(node: BabelNode | undefined): BabelNode[] | undefined {
  if (node?.type !== "ObjectExpression") return
  if (node.properties?.some(property => property.type === "SpreadElement" || property.computed || (property.key?.name ?? property.key?.value) === "__proto__")) return
  return node.properties
}

/**
 * Reads a store from the source of a Definition's default export when its provider cannot change when the module runs
 * again: `{}` for no store or a custom Store, `{ provider }` for a hosted store, and `undefined` when the source does not
 * show it. Comments do not count, because this reads the syntax tree.
 */
async function readStaticWorkspaceStore(
  file: string,
  loader: ReturnType<typeof createWorkspaceDefinitionLoader>,
  exportedName = "default",
): Promise<{ provider?: string } | undefined> {
  // Indirect and contributed exports keep every loader unless we can establish their store contract here.
  if (exportedName !== "default") return
  const loaded = await readSourceModule(file)
  if (!loaded) return
  let staticStore: { provider?: string } | undefined
  loader.transform({
    filename: loaded.file,
    jsx: extname(loaded.file).endsWith("x"),
    source: loaded.source,
    ts: /\.[cm]?tsx?$/.test(loaded.file),
    babel: {
      plugins: [() => ({
        visitor: {
          ExportDefaultDeclaration(path: BabelNodePath) {
            let definition = unwrapBabelExpression(path.node.declaration)
            if (babelCallsWorkspaceImport(definition, path, "defineWorkspace") && definition?.arguments?.length === 1) {
              definition = unwrapBabelExpression(definition.arguments[0])
            }
            const properties = babelStaticObjectProperties(definition)
            if (!properties) return
            const storeProperty = properties.findLast(property => (property.key?.name ?? property.key?.value) === "store")
            if (!storeProperty) {
              staticStore = {}
              return
            }
            if (storeProperty.type !== "ObjectProperty") return
            // SAFETY: An ObjectProperty's value is an expression node.
            const store = unwrapBabelExpression(storeProperty.value as BabelNode)
            // This public factory always returns a custom Store, independent of its runtime arguments.
            if (babelCallsWorkspaceImport(store, path, "createBlobDatabaseWorkspaceStore", "/blob-database")) {
              staticStore = {}
              return
            }
            const storeProperties = babelStaticObjectProperties(store)
            if (!storeProperties) return
            const readFile = storeProperties.findLast(property => (property.key?.name ?? property.key?.value) === "readFile")
            if (readFile) {
              // A custom Store must remain a custom Store when the module is evaluated in production.
              if (readFile.type === "ObjectMethod" && readFile.kind === "method") staticStore = {}
              return
            }
            const provider = storeProperties.findLast(property => (property.key?.name ?? property.key?.value) === "provider")
            // SAFETY: An ObjectProperty's value is an expression node.
            const providerValue = provider?.type === "ObjectProperty" ? unwrapBabelExpression(provider.value as BabelNode) : undefined
            if (providerValue?.type === "StringLiteral" && typeof providerValue.value === "string") staticStore = { provider: providerValue.value }
          },
        },
      })],
    },
  })
  return staticStore
}

/**
 * Reads each Definition's store by loading the Definition, as the runtime does. When the build cannot load a Definition,
 * it skips it only if the source shows that its store needs no Artifacts binding. Otherwise the build cannot write the
 * binding that the store may need, so it fails and tells the developer to set the store in the `workspace` config.
 */
async function resolveDefinitionCloudflareArtifactsConfigs(
  definitions: DiscoveredWorkspaceDefinition[],
  rootDir: string,
  options: {
    aliases?: Record<string, string>
    definitionOverrides?: Map<string, ResolvedWorkspaceModuleOptions>
    env?: Record<string, string | undefined>
    hosting?: string
    storeUsage?: WorkspaceDefinitionStoreUsage
  },
): Promise<ResolvedWorkspaceModuleOptions[]> {
  const loader = createWorkspaceDefinitionLoader(rootDir, options.aliases)
  const configs: ResolvedWorkspaceModuleOptions[] = []
  for (const definition of definitions) {
    const definitionFile = resolveWorkspaceDefinitionModule(loader, definition, rootDir)
    let loaded: WorkspaceDefinitionInput
    try {
      loaded = await loadDiscoveredWorkspaceDefinition(loader, definition, rootDir)
      const commonJsLoaded: WorkspaceDefinitionInput & { default?: WorkspaceDefinitionInput } = loaded
      loaded = commonJsLoaded.default ?? loaded
    }
    catch (error) {
      const store = await readStaticWorkspaceStore(definitionFile, loader, definition.export)
      if (!store || store.provider === "cloudflare-artifacts") {
        throw workspaceErrorDiagnostics.WORKSPACE_B0005({
          cause: error,
          message: `[vitehub] Workspace "${definition.name}" sets a store that may need a Cloudflare Artifacts binding, but the build cannot load ${definitionFile} to read it: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
      options.storeUsage?.add("unknown")
      continue
    }
    if (options.storeUsage && !await readStaticWorkspaceStore(definitionFile, loader, definition.export)) {
      options.storeUsage.add("unknown")
    }
    const workspace = normalizeWorkspaceDefinition(definition.name, loaded)
    if (!workspace.store) options.storeUsage?.add("default")
    if (!workspace.store || isWorkspaceStore(workspace.store)) continue
    const config = normalizeWorkspaceOptions({ store: workspace.store }, {
      dev: false,
      env: options.env || process.env,
      hosting: options.hosting ?? process.env.VITEHUB_HOSTING,
      rootDir: workspace.rootDir || rootDir,
    })
    if (config && isHostedWorkspaceStore(config.store)) options.storeUsage?.add(config.store.provider)
    if (config && config.store.provider === "cloudflare-artifacts") {
      configs.push(config)
      options.definitionOverrides?.set(definition.name, config)
    }
  }
  return configs
}

async function resolveCloudflareArtifactsConfigs(
  config: ResolvedWorkspaceModuleOptions,
  definitions: DiscoveredWorkspaceDefinition[],
  rootDir: string,
  options: {
    aliases?: Record<string, string>
    definitionOverrides?: Map<string, ResolvedWorkspaceModuleOptions>
    env?: Record<string, string | undefined>
    hosting?: string
    storeUsage?: WorkspaceDefinitionStoreUsage
  } = {},
): Promise<ResolvedWorkspaceModuleOptions[]> {
  return [
    ...(config.store.provider === "cloudflare-artifacts" ? [config] : []),
    ...await resolveDefinitionCloudflareArtifactsConfigs(definitions, rootDir, options),
  ]
}

async function writeCloudflareArtifactsProviderOutput(
  rootDir: string,
  clientOutDir: string,
  config: false | ResolvedWorkspaceModuleOptions,
  definitions: DiscoveredWorkspaceDefinition[],
  readCloudflareState: CloudflareProviderDeploymentOutputStateReader,
  write: ProviderDeploymentOutputWriter,
  aliases?: Record<string, string>,
): Promise<void> {
  const configs = config
    ? await resolveCloudflareArtifactsConfigs(config, definitions, rootDir, { aliases })
    : []
  const requestedConfig = createCloudflareArtifactsWranglerConfig(configs)
  const wranglerConfigOwnership = {
    arrays: {
      artifacts: {
        key: "binding",
        values: [] as string[],
      },
    },
  }
  const wranglerConfigOwnershipFiles = {
    artifacts: cloudflareArtifactsBindingsFileName,
  }
  const state = await readCloudflareState({
    wranglerConfigOwnership,
    wranglerConfigOwnershipFiles,
  })
  const configuredArtifacts = configuredCloudflareArtifacts(state.wranglerConfig)
  const previousBindings = state.wranglerConfigOwnership?.arrays?.artifacts?.values
    ?.filter((value): value is string => typeof value === "string") ?? []
  const ownedArtifacts = resolveOwnedCloudflareArtifacts(requestedConfig?.artifacts ?? [], configuredArtifacts, previousBindings)
  const wranglerConfig = ownedArtifacts.length ? { artifacts: ownedArtifacts } : undefined
  const nextBindings = ownedArtifacts.map(binding => binding.binding)
  if (!wranglerConfig && !previousBindings.length) return

  const nextOwnership = {
    arrays: {
      artifacts: {
        key: "binding",
        values: nextBindings,
      },
    },
  }
  await write({
    clientOutDir,
    rootDir,
    ...(wranglerConfig
      ? {
          cloudflare: {
            wranglerConfig,
            wranglerConfigOwnership: nextOwnership,
            wranglerConfigOwnershipFiles,
          },
        }
      : {
          cleanup: {
            cloudflare: {
              wranglerConfigOwnership: nextOwnership,
              wranglerConfigOwnershipFiles,
            },
          },
        }),
  })
}

export interface WorkspaceNitroConfigOptions {
  aliases?: Record<string, string>
  command?: "build" | "serve"
  env?: Record<string, string | undefined>
  hosting?: string
  nitro?: unknown
  /** Vite plugins that can contribute Workspace Definitions through `vitehub.workspaces`. */
  plugins?: readonly unknown[]
  serverDirs?: string[]
  viteRoot?: string
  workspace?: false | WorkspaceOptions
}

export type NitroConfig = {
  cloudflare?: {
    wrangler?: {
      artifacts?: Array<{ binding: string, namespace: string }>
      compatibility_flags?: string[]
    } & Record<string, unknown>
  } & Record<string, unknown>
  plugins?: unknown[]
  rollupConfig?: {
    external?: unknown
  } & Record<string, unknown>
} & Record<string, unknown>

type ViteConfigWithWorkspaceNitro = Omit<UserConfig, "nitro" | "plugins"> & {
  nitro?: NitroConfig
}

type WorkspacePluginRoots = {
  projectRoot: string
  viteRoot: string
}

function dedupeAddition(current: string[] | undefined): string[] | undefined {
  return current?.includes(WORKSPACE_PACKAGE_NAME) ? undefined : [WORKSPACE_PACKAGE_NAME]
}

function isWorkspaceFile(file: string) {
  return workspaceSuffixPattern.test(file) || workspacesDirSegment.test(file)
}

function resolveWorkspacePluginRoots(root: string, workspaceOptions: false | WorkspaceOptions | undefined): WorkspacePluginRoots {
  const resolvedViteRoot = resolve(root)
  const resolvedProjectRoot = resolveViteHubProjectRoot(resolvedViteRoot, {
    projectRoot: workspaceOptions ? workspaceOptions.projectRoot : undefined,
  })
  return { projectRoot: resolvedProjectRoot, viteRoot: resolvedViteRoot }
}

function discoverDefinitions(roots: WorkspacePluginRoots, serverDirs?: string[], contributions?: readonly CollectedWorkspaceContribution[]) {
  return discoverViteWorkspaceDefinitions(roots.viteRoot, { contributions, serverDirs, serverRootDir: roots.projectRoot })
}

async function collectPluginWorkspaceContributions(plugins: readonly unknown[] | undefined, roots: WorkspacePluginRoots, serverDirs?: string[]) {
  return await collectWorkspaceContributions(plugins, { plugins, projectRoot: roots.projectRoot, root: roots.viteRoot, serverDirs })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isWorkspaceRegistry(value: unknown): value is Record<string, () => Promise<{ default?: unknown }>> {
  return isRecord(value) && Object.values(value).every(item => typeof item === "function")
}

function workspaceDefinitionLoaderAliases(aliases: AliasOptions): Record<string, string> {
  if (!Array.isArray(aliases)) return aliases as Record<string, string>
  return Object.fromEntries(aliases.flatMap(alias =>
    typeof alias.find === "string" ? [[alias.find, alias.replacement]] : [],
  ))
}

type HostedWorkspaceStoreProvider = "cloudflare-artifacts" | "github" | "vercel-blob"

const hostedWorkspaceStoreProviders: readonly HostedWorkspaceStoreProvider[] = ["cloudflare-artifacts", "github", "vercel-blob"]

/**
 * What a build learned about the stores of the discovered definitions: a hosted provider, `default` for a definition
 * without a store, or `unknown` for a definition the build could not load or whose store may change at runtime.
 */
type WorkspaceDefinitionStoreUsage = Set<HostedWorkspaceStoreProvider | "default" | "unknown">

function isHostedWorkspaceStore(store: ResolvedWorkspaceModuleOptions["store"]): store is Extract<ResolvedWorkspaceModuleOptions["store"], { provider: HostedWorkspaceStoreProvider }> {
  return store.provider === "cloudflare-artifacts" || store.provider === "github" || store.provider === "vercel-blob"
}

/**
 * The hosted stores the Nitro plugin installs. Each store pulls its client into the server startup, so a build installs
 * only the stores that its definitions use. Without `storeUsage` (dev) it installs every store.
 */
function resolveNitroHostedStoreProviders(
  config: false | ResolvedWorkspaceModuleOptions,
  definitionCount: number,
  storeUsage: WorkspaceDefinitionStoreUsage | undefined,
): Set<HostedWorkspaceStoreProvider> {
  const configProvider = config && isHostedWorkspaceStore(config.store) ? config.store.provider : undefined
  if (!storeUsage) return new Set(configProvider || definitionCount > 0 ? hostedWorkspaceStoreProviders : [])
  if (storeUsage.has("unknown")) return new Set(hostedWorkspaceStoreProviders)
  const providers = new Set<HostedWorkspaceStoreProvider>(configProvider ? [configProvider] : [])
  for (const usage of storeUsage) {
    if (usage === "unknown") continue
    // A definition without a store uses the runtime config. Without one, `BLOB_STORE_ID` at runtime selects Vercel Blob.
    if (usage === "default") {
      if (!config) providers.add("vercel-blob")
      continue
    }
    providers.add(usage)
  }
  return providers
}

function acceptsWorkspaceDevStream(req: IncomingMessage): boolean {
  const accept = Array.isArray(req.headers.accept) ? req.headers.accept.join(",") : req.headers.accept
  return Boolean(accept?.includes("application/x-ndjson"))
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = ""
  req.setEncoding("utf8")
  for await (const chunk of req) body += chunk
  return body
}

function createAbortSignalFromClose(target: Pick<ServerResponse, "off" | "once">, message: string): { dispose: () => void, signal: AbortSignal } {
  const controller = new AbortController()
  const abort = () => controller.abort(workspaceErrorDiagnostics.WORKSPACE_R0028({ message: message }))
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

function streamWorkspaceDevCommand(input: Parameters<typeof runWorkspaceDevCommand>[0], closeHost: () => Promise<void>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const write = (value: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
      try {
        const result = await runWorkspaceDevCommand({
          ...input,
          onProgress: async event => write({ event, type: "progress" }),
        })
        write({ result, type: "result" })
      }
      catch (error) {
        write({ error: error instanceof Error ? error.message : String(error), type: "error" })
      }
      finally {
        await closeHost()
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  })
}

async function handleWorkspaceDevRequest(server: ViteDevServer, req: IncomingMessage, workspaces: Array<{ name: string }>, tokenOptions: WorkspaceDevTokenOptions, abortSignal?: AbortSignal): Promise<Response> {
  if (req.method === "GET") {
    await ensureWorkspaceDevToken(server.config.root, tokenOptions)
    return Response.json({
      root: server.config.root,
      workspaceDevTokenServerId: tokenOptions.serverId,
      workspaces,
    })
  }
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 })

  let body: unknown
  try {
    body = JSON.parse(await readRequestBody(req))
  }
  catch {
    return new Response("Malformed Workspace Dev payload.", { status: 400 })
  }
  const command = isRecord(body) && isRecord(body.workspaceCommand) ? body.workspaceCommand : undefined
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
  // Keep the dev-only runtime out of provider output tracing.
  const { resolveSandbox } = await import("@vite-hub/" + "sandbox") as typeof import("@vite-hub/sandbox")
  const host = await (await resolveSandbox({ runtime: "trusted-host" }, {})).open({ signal: abortSignal })
  const input = {
    abortSignal,
    ...(args ? { args } : {}),
    command: command.command,
    host,
    ...(isRecord(definition) ? { definition: normalizeWorkspaceDefinition(command.workspace, definition as never) } : {}),
    ...(paths?.length ? { paths } : {}),
    ...(timeout ? { timeout } : {}),
    workspace: command.workspace,
  }
  if (acceptsWorkspaceDevStream(req)) return streamWorkspaceDevCommand(input, () => host.close())
  try {
    return Response.json(await runWorkspaceDevCommand(input))
  }
  finally {
    await host.close()
  }
}

function hasNitroPlugin(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasNitroPlugin)
  return isRecord(value) && typeof value.name === "string" && value.name.startsWith("nitro:")
}

function hasNitroConfig(config: UserConfig): boolean {
  return "nitro" in config || hasNitroPlugin(config.plugins)
}

function hasExplicitWorkspaceRuntimeOptions(options: false | WorkspaceOptions | undefined): boolean {
  return Boolean(options && (options.root || options.store))
}

function shouldInstallNitroWorkspacePlugin(
  config: UserConfig,
  options: false | WorkspaceOptions | undefined,
  normalized: ResolvedWorkspaceModuleOptions,
  definitions: DiscoveredWorkspaceDefinition[],
): boolean {
  return isHostedWorkspaceStore(normalized.store)
    || hasExplicitWorkspaceRuntimeOptions(options)
    || (hasNitroConfig(config) && definitions.length > 0)
}

function mergeNitroWorkspaceConfig(value: unknown, dev: boolean): NitroConfig {
  const nitro: NitroConfig = isRecord(value) ? { ...value } : {}
  const kit = createNitroServerKit(nitro)
  kit.addPlugin(generatedNitroWorkspacePlugin, dev ? "start" : "end")
  // SAFETY: The kit preserves the Nitro config object shape while adding the generated plugin.
  return kit.config as NitroConfig
}

function configureNitroWorkspaceAssets(nitro: NitroConfig, root: string): void {
  // Nuxt 4 bundles the server with Nitro 2 outside Vite, so `resolveId` below never sees the assets registry. The
  // alias gives that bundle the files that `buildStart` writes, for hosts without a file system.
  // The Nitro types of the host decide the alias type, so read it as a plain record.
  const alias: unknown = nitro.alias
  nitro.alias = { ...(alias && typeof alias === "object" ? alias : {}), [WORKSPACE_ASSETS_REGISTRY_ID]: resolve(root, workspaceAssetsRegistryPath) }
}

function configureCloudflareNitroRuntime(nitro: NitroConfig): void {
  nitro.cloudflare ??= {}
  nitro.cloudflare.wrangler ??= {}
  nitro.cloudflare.nodeCompat = true
  const rollupConfig = isRecord(nitro.rollupConfig) ? { ...nitro.rollupConfig } : {}
  nitro.rollupConfig = { ...rollupConfig, external: mergeNitroExternal(rollupConfig.external, "cloudflare:workers") }
}

function moduleImportSpecifier(fromFile: string, targetFile: string): string {
  const specifier = relative(dirname(fromFile), targetFile).replace(/\\/g, "/")
  return specifier.startsWith(".") ? specifier : `./${specifier}`
}

function shouldConfigureRuntime(options: false | WorkspaceOptions | undefined, normalized: ResolvedWorkspaceModuleOptions): boolean {
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

function runtimeWorkspaceConfig(
  config: false | ResolvedWorkspaceModuleOptions,
  options: false | WorkspaceOptions | undefined,
  cloudflareRuntime: boolean,
): false | ResolvedWorkspaceModuleOptions {
  if (!cloudflareRuntime || !config || config.store.provider !== "github" || !options) return config
  const store = options.store
  if (!store || isWorkspaceStore(store) || store.provider !== "github") return config
  const runtimeStore = { ...config.store }
  const isAbsent = (value: unknown) => typeof value === "undefined" || (typeof value === "string" && value.trim().length === 0)
  for (const key of ["branch", "root", "token"] as const) {
    if (typeof store[key] === "function") {
      runtimeStore[key] = store[key]
    }
    else if (isAbsent(store[key])) {
      delete runtimeStore[key]
    }
  }
  if (typeof store.repository === "function") {
    runtimeStore.repository = store.repository
  }
  else if (typeof store.repo === "function") {
    runtimeStore.repo = store.repo
    delete runtimeStore.repository
  }
  else if (isAbsent(store.repository) && isAbsent(store.repo)) {
    delete runtimeStore.repository
    delete runtimeStore.repo
  }
  return { ...config, store: runtimeStore }
}

const hostedStoreInstallers: Record<HostedWorkspaceStoreProvider, { entry: string, name: string }> = {
  "cloudflare-artifacts": { entry: "hosted", name: "installHostedCloudflareArtifactsWorkspaceStore" },
  "github": { entry: "hosted", name: "installHostedGitHubWorkspaceStore" },
  "vercel-blob": { entry: "hosted-vercel-blob", name: "installHostedVercelBlobWorkspaceRuntime" },
}

function renderNitroWorkspacePlugin(
  config: false | ResolvedWorkspaceModuleOptions,
  registryImport: string,
  hostedStores: ReadonlySet<HostedWorkspaceStoreProvider>,
  cloudflareRuntime: boolean,
): string {
  // A light module: the Workspace core loads on the first Workspace call, not at server startup.
  const runtimeImport = ownModule(import.meta.url, "runtime/registry")
  const hostedConfig = config && isHostedWorkspaceStore(config.store) ? config : undefined
  const isVercelBlobStore = hostedConfig?.store.provider === "vercel-blob"
  const configure = hostedConfig
    ? isVercelBlobStore
      ? { entry: "hosted-vercel-blob", name: "configureHostedVercelBlobWorkspaceRuntime" }
      : { entry: "hosted", name: "configureHostedWorkspaceRuntime" }
    : undefined
  // `configure*` installs the store of the runtime config itself.
  const installers = hostedWorkspaceStoreProviders
    .filter(provider => hostedStores.has(provider) && provider !== hostedConfig?.store.provider)
    .map(provider => hostedStoreInstallers[provider])
  const importsByEntry = new Map<string, string[]>()
  for (const { entry, name } of [...(configure ? [configure] : []), ...installers]) {
    importsByEntry.set(entry, [...importsByEntry.get(entry) ?? [], name])
  }
  const runtimeImports = [
    ...[...importsByEntry].map(([entry, names]) => `import { ${names.join(", ")} } from ${JSON.stringify(ownModule(import.meta.url, entry))}`),
    `import { ${config && !hostedConfig ? "setWorkspaceRuntimeConfig, " : ""}setWorkspaceRuntimeRegistry } from ${JSON.stringify(runtimeImport)}`,
  ]
  if (cloudflareRuntime) {
    runtimeImports.unshift(
      "import { env as vitehubEnv } from 'cloudflare:workers'",
      `import { setActiveCloudflareEnv } from ${JSON.stringify(ownModule(import.meta.url, "runtime/state"))}`,
    )
  }
  const runtimeSetup = [
    ...(configure && hostedConfig ? [`  ${configure.name}(${renderRuntimeValue({ root: hostedConfig.root, store: hostedConfig.store })})`] : []),
    ...installers.map(({ name }) => `  ${name}()`),
    ...(config && !hostedConfig ? [`  setWorkspaceRuntimeConfig(${renderRuntimeValue({ root: config.root, store: config.store })})`] : []),
  ]

  return [
    ...runtimeImports,
    `import registry from ${JSON.stringify(registryImport)}`,
    "",
    "setWorkspaceRuntimeRegistry(registry)",
    "",
    "export default function vitehubWorkspacePlugin() {",
    ...(cloudflareRuntime ? ["  setActiveCloudflareEnv(vitehubEnv)"] : []),
    ...runtimeSetup,
    "}",
    "",
  ].join("\n")
}

async function writeNitroWorkspacePlugin(
  root: string,
  config: false | ResolvedWorkspaceModuleOptions,
  options: false | WorkspaceOptions | undefined,
  definitions: DiscoveredWorkspaceDefinition[],
  cloudflareRuntime = false,
  definitionOverrides?: Map<string, ResolvedWorkspaceModuleOptions>,
  storeUsage?: WorkspaceDefinitionStoreUsage,
): Promise<void> {
  const pluginFile = resolve(root, generatedNitroWorkspacePlugin)
  const registryFile = resolve(root, generatedNitroWorkspaceRegistry)
  const runtimeConfig = runtimeWorkspaceConfig(config, options, cloudflareRuntime)
  await writeFileIfChanged(registryFile, createWorkspaceRegistryContents(registryFile, definitions, definitionOverrides))
  // Durability reads Definitions synchronously at boot. Awaited imports here can cycle back through `nitro/app`.
  const durabilityRegistryFile = resolve(root, generatedNitroWorkspaceDurabilityRegistry)
  await writeFileIfChanged(durabilityRegistryFile, createWorkspaceRegistryContents(durabilityRegistryFile, definitions, definitionOverrides, true))
  await writeFileIfChanged(
    pluginFile,
    renderNitroWorkspacePlugin(
      runtimeConfig,
      moduleImportSpecifier(pluginFile, registryFile),
      resolveNitroHostedStoreProviders(runtimeConfig, definitions.length, storeUsage),
      cloudflareRuntime,
    ),
  )
}

export async function createWorkspaceNitroConfig(options: WorkspaceNitroConfigOptions = {}): Promise<NitroConfig | null> {
  const workspaceOptions = stripWorkspaceInternalOptions(options.workspace)
  const roots = resolveWorkspacePluginRoots(options.viteRoot || process.cwd(), workspaceOptions)
  const env = options.env || process.env
  const hosting = resolveHostPreset({ env, hosting: options.hosting, nitro: options.nitro })
  const normalized = normalizeWorkspaceOptions(workspaceOptions, {
    dev: options.command !== "build",
    env,
    hosting,
    rootDir: roots.projectRoot,
  })
  if (!normalized) return null

  const contributions = await collectPluginWorkspaceContributions(options.plugins, roots, options.serverDirs)
  const definitions = discoverDefinitions(roots, options.serverDirs, contributions)
  if (!isHostedWorkspaceStore(normalized.store) && !hasExplicitWorkspaceRuntimeOptions(workspaceOptions) && definitions.length === 0) return null

  const definitionOverrides = new Map<string, ResolvedWorkspaceModuleOptions>()
  const storeUsage: WorkspaceDefinitionStoreUsage | undefined = options.command === "build" ? new Set() : undefined
  const cloudflareArtifactsConfigs = await resolveCloudflareArtifactsConfigs(normalized, definitions, roots.projectRoot, {
    aliases: options.aliases,
    env: options.env,
    hosting,
    definitionOverrides,
    storeUsage,
  })
  const runtimeConfig = shouldConfigureRuntime(workspaceOptions, normalized) ? normalized : false
  const cloudflareRuntime = cloudflareArtifactsConfigs.length > 0 || getHostingProvider(hosting) === "cloudflare"
  await writeNitroWorkspacePlugin(roots.projectRoot, runtimeConfig, workspaceOptions, definitions, cloudflareRuntime, definitionOverrides, storeUsage)
  const nitro = mergeNitroWorkspaceConfig(options.nitro, options.command !== "build")
  if (options.command === "build") configureNitroWorkspaceAssets(nitro, roots.projectRoot)
  for (const config of cloudflareArtifactsConfigs) configureCloudflareArtifacts(nitro, config)
  if (cloudflareRuntime) configureCloudflareNitroRuntime(nitro)
  return nitro
}

export interface WorkspaceVitePluginAPI {
  getWorkspaces: () => Array<{ name: string }>
}

interface WorkspaceCliContributingPlugin {
  vitehub?: ViteHubInspectionPluginMetadata & DurabilityPluginMetadata & { cli?: () => unknown | Promise<unknown>, operations?: readonly OperationContributionEntry[] }
}

const setWorkspacePluginHosting: unique symbol = Symbol("vitehub.workspace.setHosting")

type WorkspacePluginHosting = string | (() => string | undefined)

export type WorkspaceVitePlugin = Plugin & WorkspaceCliContributingPlugin & {
  [setWorkspacePluginHosting]?: (hosting: WorkspacePluginHosting) => void
  api: WorkspaceVitePluginAPI
}

export function setWorkspaceVitePluginHosting(plugin: unknown, hosting: WorkspacePluginHosting): boolean {
  if (!plugin || typeof plugin !== "object") return false
  const setter = (plugin as WorkspaceVitePlugin)[setWorkspacePluginHosting]
  if (!setter) return false
  setter(hosting)
  return true
}

interface InternalWorkspaceModuleOptions extends WorkspaceOptions {
  hosting?: WorkspacePluginHosting
}

function stripWorkspaceInternalOptions(options: false | WorkspaceOptions | undefined): false | WorkspaceOptions | undefined {
  if (!options || !Object.hasOwn(options, "hosting")) return options
  const publicOptions = { ...options } as InternalWorkspaceModuleOptions
  delete publicOptions.hosting
  return publicOptions
}

export function hubWorkspace(options?: WorkspaceOptions | false): WorkspaceVitePlugin {
  let hosting = (options ? options as InternalWorkspaceModuleOptions : undefined)?.hosting
  const publicOptions = stripWorkspaceInternalOptions(options)
  let resolved: ResolvedConfig | undefined
  let providerOutput: ReturnType<typeof useProviderOutputCatalog> | undefined
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  let resolvedOptions: ReturnType<typeof normalizeWorkspaceOptions> | undefined
  let projectRoot: string | undefined
  let viteRoot: string | undefined
  let assetsRegistryFile: string | undefined
  let manifest: WorkspaceBuildState["manifest"] = { workspaces: [] }
  let registryContents = "export default {}\n"
  let server: ViteDevServer | undefined
  let serverDirs: string[] | undefined
  let contributions: CollectedWorkspaceContribution[] = []

  async function refreshManifest(roots: WorkspacePluginRoots) {
    const definitions = discoverDefinitions(roots, serverDirs, contributions)
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
    [setWorkspacePluginHosting](value) {
      hosting = value
    },
    api: {
      getWorkspaces: () => manifest.workspaces,
    },
    async config(config, env) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const workspaceOptions = publicOptions
      const roots = resolveWorkspacePluginRoots(config.root || process.cwd(), workspaceOptions)
      const resolvedHosting = resolveHostPreset({
        hosting: typeof hosting === "function" ? hosting() : hosting,
        nitro: (config as ViteConfigWithWorkspaceNitro).nitro,
      })
      const normalized = normalizeWorkspaceOptions(workspaceOptions, {
        dev: env?.command !== "build",
        env: process.env,
        hosting: resolvedHosting,
        rootDir: roots.projectRoot,
      })
      const runtimeOptions = resolvedHosting && normalized && normalized.store.provider !== "local"
        ? { ...workspaceOptions, store: workspaceOptions && workspaceOptions.store ? workspaceOptions.store : normalized.store }
        : workspaceOptions
      const viteConfig: Omit<UserConfig, "plugins"> = {
        server: {
          watch: {
            ignored: generatedViteHubWatchIgnoredAddition(config.server?.watch?.ignored),
          },
        },
      }
      if (normalized) contributions = await collectPluginWorkspaceContributions(config.plugins, roots, serverDirs)
      const definitions = normalized ? discoverDefinitions(roots, serverDirs, contributions) : []
      if (normalized && shouldInstallNitroWorkspacePlugin(config, runtimeOptions, normalized, definitions)) {
        const runtimeConfig = shouldConfigureRuntime(runtimeOptions, normalized) ? normalized : false
        const definitionOverrides = new Map<string, ResolvedWorkspaceModuleOptions>()
        // Dev regenerates the plugin when definitions change, so it keeps every hosted store.
        const storeUsage: WorkspaceDefinitionStoreUsage | undefined = env?.command === "build" ? new Set() : undefined
        const artifacts = await resolveCloudflareArtifactsConfigs(normalized, definitions, roots.projectRoot, {
          aliases: config.resolve?.alias ? workspaceDefinitionLoaderAliases(config.resolve.alias) : undefined,
          hosting: resolvedHosting,
          definitionOverrides,
          storeUsage,
        })
        const usesCloudflareArtifacts = artifacts.length > 0
        const usesCloudflareRuntime = usesCloudflareArtifacts || getHostingProvider(resolvedHosting) === "cloudflare"
        await writeNitroWorkspacePlugin(roots.projectRoot, runtimeConfig, runtimeOptions, definitions, usesCloudflareRuntime, definitionOverrides, storeUsage)
        const nitro = mergeNitroWorkspaceConfig((config as ViteConfigWithWorkspaceNitro).nitro, env?.command === "serve")
        if (env?.command === "build") configureNitroWorkspaceAssets(nitro, roots.projectRoot)
        for (const artifactConfig of artifacts) configureCloudflareArtifacts(nitro, artifactConfig)
        if (usesCloudflareRuntime) configureCloudflareNitroRuntime(nitro)
        // Replace the Nitro config in place. A returned Nitro config would repeat its arrays when Vite merges it.
        ;(config as ViteConfigWithWorkspaceNitro).nitro = nitro
      }
      return viteConfig
    },
    async configResolved(config) {
      resolved = config
      providerOutput = useProviderOutputCatalog(config)
      const workspaceOptions = publicOptions
      const roots = resolveWorkspacePluginRoots(config.root, workspaceOptions)
      projectRoot = roots.projectRoot
      viteRoot = roots.viteRoot
      const resolvedHosting = resolveHostPreset({
        hosting: typeof hosting === "function" ? hosting() : hosting,
        nitro: (config as ResolvedConfig & { nitro?: NitroConfig }).nitro,
      })
      if (config.command !== "build")
        process.env.VITEHUB_WORKSPACE_DEV = "true"
      else
        delete process.env.VITEHUB_WORKSPACE_DEV
      resolvedOptions = normalizeWorkspaceOptions(workspaceOptions, {
        dev: config.command !== "build",
        env: process.env,
        hosting: resolvedHosting,
        rootDir: roots.projectRoot,
      })
      if (resolvedOptions) contributions = await collectPluginWorkspaceContributions(config.plugins, roots, serverDirs)
      assetsRegistryFile = resolve(roots.projectRoot, workspaceAssetsRegistryPath)
      await initializeWorkspaceAssetRegistry(assetsRegistryFile)
      await refreshManifest(roots)
    },
    configEnvironment(name, config, env) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: {
          dedupe: dedupeAddition(config.resolve?.dedupe),
          ...(loadsViteHubPackagesNatively(name, env) ? {} : { noExternal: noExternalAddition(config.resolve?.noExternal) }),
        },
      }
    },
    async buildStart() {
      providerOutputGenerations.capture(this, providerOutput)
      if (!resolved || !resolvedOptions) return
      const roots = {
        projectRoot: projectRoot || resolveViteHubProjectRoot(resolved.root),
        viteRoot: viteRoot || resolve(resolved.root),
      }
      await refreshManifest(roots)
      if (resolved.command !== "build" || !assetsRegistryFile) return

      const definitions = discoverDefinitions(roots, serverDirs, contributions)
      await syncWorkspaceBuildAssets(definitions, roots.projectRoot, resolvedOptions, assetsRegistryFile)
    },
    async buildEnd(error) {
      if (error) {
        await providerOutputGenerations.reset(this, providerOutput, error)
        return
      }
      if (!resolved || !resolvedOptions || shouldSkipViteProviderBuild(resolved.command)) return
      const workspaceOptions = resolvedOptions
      const roots = {
        projectRoot: projectRoot || resolveViteHubProjectRoot(resolved.root),
        viteRoot: viteRoot || resolve(resolved.root),
      }
      providerOutputGenerations.defer(this, providerOutput, {
        owner: "workspace",
        rootDir: roots.projectRoot,
        write: async ({ readCloudflareState, signal, write }) => {
          const definitions = discoverDefinitions(roots, serverDirs, contributions)
          await copyVercelFunctionRuntimePackages({
            packages: vercelFunctionRuntimePackages(),
            rootDir: roots.projectRoot,
            signal,
          })
          await writeCloudflareArtifactsProviderOutput(
            roots.projectRoot,
            resolved!.build?.outDir ?? "dist/client",
            workspaceOptions,
            definitions,
            readCloudflareState,
            write,
            resolved!.resolve ? workspaceDefinitionLoaderAliases(resolved!.resolve.alias) : undefined,
          )
        },
      })
    },
    async renderError(error) {
      await providerOutputGenerations.reset(this, providerOutput, error)
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        if (!resolved || shouldSkipViteProviderBuild(resolved.command)) return
        providerOutputGenerations.ready(this)
        await finalizeProviderDeploymentOutputs(providerOutput)
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
      registerViteHubDevEndpoint(devServer, {
        handle: (req, res) => {
          const abort = createAbortSignalFromClose(res, "[vitehub] Workspace Dev response closed.")
          void handleWorkspaceDevRequest(devServer, req, manifest.workspaces, tokenOptions, abort.signal)
            .then(response => writeResponse(res, response))
            .catch((error: unknown) => writeResponse(res, new Response(error instanceof Error ? error.message : "Workspace Dev request failed.", { status: 500 })))
            .finally(abort.dispose)
        },
        header: workspaceDevHeader,
        headerValue: workspaceDevHeaderValue,
        label: "Workspace Dev",
        route: workspaceDevRoute,
      })
    },
    vitehub: {
      durability: () => {
        if (!resolvedOptions) return []
        const root = projectRoot ?? process.cwd()
        const module = resolve(root, ".vitehub/nitro/workspace/durability.mjs")
        const registry = resolve(root, generatedNitroWorkspaceDurabilityRegistry)
        const definitions = discoverDefinitions({ projectRoot: root, viteRoot: viteRoot ?? root }, serverDirs, contributions)
        const config = shouldConfigureRuntime(publicOptions, resolvedOptions) ? resolvedOptions : false
        writeFileIfChangedSync(module, [
          `import { workspaceDefinitionsDurability } from ${JSON.stringify(ownModule(import.meta.url, "durability"))}`,
          ...(definitions.length ? [
            `import registry from ${JSON.stringify(registry)}`,
          ] : []),
          "export function workspaceDurability(_input, context) {",
          definitions.length
            ? "  const definitions = Object.fromEntries(Object.entries(registry).map(([name, load]) => [name, load().default]))"
            : "  const definitions = {}",
          `  return workspaceDefinitionsDurability(definitions, ${renderRuntimeValue(config)}, context)`,
          "}",
          "",
        ].join("\n"))
        return [{ export: "workspaceDurability", input: {}, module, primitive: "workspace" }]
      },
      // The Console, `vitehub workspace history|refs|show`, and agents run these. The app imports them through `vite-hub`.
      operations: [{ export: "workspaceOperations", load: async () => workspaceOperations, module: ownModule(import.meta.url, "operations") }],
      cli: async () => {
        return createWorkspaceCliContributor()
      },
      inspect: async () => {
        if (resolvedOptions === false) return
        const roots = projectRoot && viteRoot
          ? { projectRoot, viteRoot }
          : resolveWorkspacePluginRoots(resolved?.root ?? process.cwd(), publicOptions)
        const artifacts = resolvedOptions
          ? await resolveCloudflareArtifactsConfigs(resolvedOptions, discoverDefinitions(roots, serverDirs, contributions), roots.projectRoot, {
              aliases: resolved?.resolve ? workspaceDefinitionLoaderAliases(resolved.resolve.alias) : undefined,
            })
          : []
        return {
          definitions: [{
            kind: "workspace",
            label: "Workspaces",
            list: () => {
              const roots = projectRoot && viteRoot
                ? { projectRoot, viteRoot }
                : resolveWorkspacePluginRoots(resolved?.root ?? process.cwd(), publicOptions)
              return inspectWorkspaceDefinitions({ plugins: resolved?.plugins, projectRoot: roots.projectRoot, rootDir: roots.viteRoot, serverDirs, serverRootDir: roots.projectRoot })
            },
          }],
          providerOutput: artifacts.length > 0
            ? [{
                description: "Generated Cloudflare Workspace artifacts config",
                owner: "workspace",
                path: resolve(createDefaultCloudflareOutputRoot(roots.projectRoot), "wrangler.json"),
              }]
            : [],
        }
      },
    },
    async handleHotUpdate(ctx: HmrContext) {
      if (!resolved) return
      await maybeRefreshTypesForFile({
        projectRoot: projectRoot || resolveViteHubProjectRoot(resolved.root),
        viteRoot: viteRoot || resolve(resolved.root),
      }, ctx.file)
    },
    resolveId: {
      filter: { id: WORKSPACE_ID_PATTERN },
      handler(id) {
        if (id === WORKSPACE_ASSETS_REGISTRY_ID) return assetsRegistryFile
        if (id === WORKSPACE_REGISTRY_ID) return RESOLVED_WORKSPACE_REGISTRY_ID
        if (id === WORKSPACES_ID) return RESOLVED_WORKSPACES_ID
        if (id.startsWith(WORKSPACE_PREFIX)) return `${RESOLVED_WORKSPACE_PREFIX}${id.slice(WORKSPACE_PREFIX.length)}`
      },
    },
    load: {
      filter: { id: WORKSPACE_LOAD_ID_PATTERN },
      handler(id) {
        if (id === RESOLVED_WORKSPACE_REGISTRY_ID) return registryContents
        if (id === RESOLVED_WORKSPACES_ID) {
          return `export const workspaces = ${JSON.stringify(manifest.workspaces)};\nexport default { workspaces };\n`
        }
        if (id.startsWith(RESOLVED_WORKSPACE_PREFIX)) {
          const name = id.slice(RESOLVED_WORKSPACE_PREFIX.length)
          const workspace = manifest.workspaces.find(item => item.name === name)
          return `const manifest = ${JSON.stringify(workspace ? { ...workspace, entries: [] } : { name, entries: [] })};\nexport default manifest;\n`
        }
        // The generated Nitro plugin imports Workspace files by path. In `vite dev`, Node loads them, as it loads the app's imports.
        return loadNativePackageModule(id, this.environment?.name, resolved?.command ?? "build")
      },
    },
  }
}
