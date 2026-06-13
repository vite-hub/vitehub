import { mkdir, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

import { copyVercelFunctionRuntimePackages } from "@vite-hub/internal/build/vercel-runtime-packages"
import { createNoExternalMerger, isServerEnvironment, mergeGeneratedViteHubWatchIgnored, resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"

import { initializeWorkspaceAssetRegistry, refreshWorkspaceBuildState, syncWorkspaceBuildAssets } from "../../build/integration.ts"
import { normalizeWorkspaceOptions } from "../../config.ts"
import { createWorkspaceRegistryContents, discoverViteWorkspaceDefinitions } from "../../build/discovery.ts"
import { workspaceSuffixPattern } from "../../build/workspace-config.ts"

import type { HmrContext, Plugin, ResolvedConfig, UserConfig, ViteDevServer } from "vite"
import type { WorkspaceBuildState } from "../../build/integration.ts"
import type { DiscoveredWorkspaceDefinition } from "../../build/discovery.ts"
import type { ResolvedWorkspaceModuleOptions, WorkspaceModuleOptions } from "../../core/types.ts"

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

type NitroConfig = {
  plugins?: unknown[]
} & Record<string, unknown>

type ViteConfigWithWorkspaceNitro = Omit<UserConfig, "plugins"> & {
  nitro?: NitroConfig
}

function mergeDedupe(current: string[] | undefined): string[] {
  if (!current) return [WORKSPACE_PACKAGE_NAME]
  return current.includes(WORKSPACE_PACKAGE_NAME) ? current : [...current, WORKSPACE_PACKAGE_NAME]
}

function isWorkspaceFile(file: string) {
  return workspaceSuffixPattern.test(file) || workspacesDirSegment.test(file)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isHostedWorkspaceStore(store: ResolvedWorkspaceModuleOptions["store"]): boolean {
  return store.provider === "cloudflare-artifacts" || store.provider === "github"
}

function hasNitroConfig(config: UserConfig): boolean {
  return "nitro" in config
}

function shouldInstallNitroWorkspacePlugin(config: UserConfig, normalized: ResolvedWorkspaceModuleOptions, definitions: DiscoveredWorkspaceDefinition[]): boolean {
  return isHostedWorkspaceStore(normalized.store) || (hasNitroConfig(config) && definitions.length > 0)
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

function renderNitroWorkspacePlugin(config: false | ResolvedWorkspaceModuleOptions, registryImport: string): string {
  const configureRuntime = config
    ? [
        "import { configureCloudflareWorkspaceRuntime } from '@vite-hub/workspace/cloudflare'",
      ]
    : []
  const runtimeSetup = config
    ? [
        `  configureCloudflareWorkspaceRuntime(${JSON.stringify({ root: config.root, store: config.store }, null, 2)})`,
      ]
    : []

  return [
    ...configureRuntime,
    `import registry from ${JSON.stringify(registryImport)}`,
    "import { setWorkspaceRuntimeRegistry } from '@vite-hub/workspace/runtime'",
    "import { definePlugin } from 'nitro'",
    "",
    "export default definePlugin(() => {",
    "  setWorkspaceRuntimeRegistry(registry)",
    ...runtimeSetup,
    "})",
    "",
  ].join("\n")
}

async function writeNitroWorkspacePlugin(root: string, config: false | ResolvedWorkspaceModuleOptions, definitions: DiscoveredWorkspaceDefinition[]): Promise<void> {
  const pluginFile = resolve(root, generatedNitroWorkspacePlugin)
  const registryFile = resolve(root, generatedNitroWorkspaceRegistry)
  await Promise.all([
    mkdir(dirname(pluginFile), { recursive: true }),
    mkdir(dirname(registryFile), { recursive: true }),
  ])
  await writeFile(registryFile, createWorkspaceRegistryContents(registryFile, definitions), "utf8")
  await writeFile(pluginFile, renderNitroWorkspacePlugin(config, moduleImportSpecifier(pluginFile, registryFile)), "utf8")
}

export interface WorkspaceVitePluginAPI {
  getWorkspaces: () => Array<{ name: string }>
}

export type WorkspaceVitePlugin = Plugin & { api: WorkspaceVitePluginAPI }

export function hubWorkspace(options?: WorkspaceModuleOptions): WorkspaceVitePlugin {
  let resolved: ResolvedConfig | undefined
  let resolvedOptions: ReturnType<typeof normalizeWorkspaceOptions> = false
  let workspaceRoot: string | undefined
  let assetsRegistryFile: string | undefined
  let manifest: WorkspaceBuildState["manifest"] = { workspaces: [] }
  let registryContents = "export default {}\n"
  let server: ViteDevServer | undefined

  async function refreshManifest(root: string) {
    const definitions = discoverViteWorkspaceDefinitions(root)
    const state = await refreshWorkspaceBuildState(root, definitions)
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

  async function maybeRefreshTypesForFile(root: string, file: string) {
    if (!isWorkspaceFile(file)) return
    await refreshManifest(root)
    invalidateVirtualWorkspaceModules()
  }

  return {
    name: "@vite-hub/workspace/vite",
    enforce: "pre",
    api: {
      getWorkspaces: () => manifest.workspaces,
    },
    async config(config, env) {
      const root = resolveViteHubProjectRoot(config.root || process.cwd())
      const normalized = normalizeWorkspaceOptions((config as UserConfig & { workspace?: false | WorkspaceModuleOptions }).workspace ?? options, {
        dev: env?.command !== "build",
        env: process.env,
        hosting: process.env.VITEHUB_HOSTING,
        rootDir: root,
      })
      const viteConfig: ViteConfigWithWorkspaceNitro = {
        server: {
          watch: {
            ignored: mergeGeneratedViteHubWatchIgnored(config.server?.watch?.ignored),
          },
        },
      }
      const definitions = normalized ? discoverViteWorkspaceDefinitions(root) : []
      if (normalized && shouldInstallNitroWorkspacePlugin(config, normalized, definitions)) {
        await writeNitroWorkspacePlugin(root, isHostedWorkspaceStore(normalized.store) ? normalized : false, definitions)
        viteConfig.nitro = mergeNitroWorkspaceConfig((config as ViteConfigWithWorkspaceNitro).nitro)
      }
      return viteConfig
    },
    async configResolved(config) {
      resolved = config
      workspaceRoot = resolveViteHubProjectRoot(config.root)
      if (config.command !== "build")
        process.env.VITEHUB_WORKSPACE_DEV = "true"
      else
        delete process.env.VITEHUB_WORKSPACE_DEV
      resolvedOptions = normalizeWorkspaceOptions((config as ResolvedConfig & { workspace?: false | WorkspaceModuleOptions }).workspace ?? options, {
        dev: config.command !== "build",
        env: process.env,
        hosting: process.env.VITEHUB_HOSTING,
        rootDir: workspaceRoot,
      })
      assetsRegistryFile = resolve(workspaceRoot, ".vitehub/vite-runtime/workspace/assets/registry.mjs")
      await initializeWorkspaceAssetRegistry(assetsRegistryFile)
      await refreshManifest(workspaceRoot)
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
      const root = workspaceRoot || resolveViteHubProjectRoot(resolved.root)
      await refreshManifest(root)
      if (resolved.command !== "build" || !assetsRegistryFile) return

      const definitions = discoverViteWorkspaceDefinitions(root)
      await syncWorkspaceBuildAssets(definitions, root, resolvedOptions, assetsRegistryFile)
    },
    closeBundle: {
      order: "post",
      async handler() {
        if (!resolved || resolved.command !== "build") return
        await copyVercelFunctionRuntimePackages({
          packages: [{ name: WORKSPACE_PACKAGE_NAME, resolveFrom: import.meta.url }],
          rootDir: workspaceRoot || resolveViteHubProjectRoot(resolved.root),
        })
      },
    },
    configureServer(devServer) {
      server = devServer
      const root = workspaceRoot || resolveViteHubProjectRoot(devServer.config.root)
      const refresh = async (file: string) => await maybeRefreshTypesForFile(root, file)
      devServer.watcher.on("add", refresh)
      devServer.watcher.on("unlink", refresh)
    },
    async handleHotUpdate(ctx: HmrContext) {
      if (!resolved) return
      await maybeRefreshTypesForFile(workspaceRoot || resolveViteHubProjectRoot(resolved.root), ctx.file)
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
