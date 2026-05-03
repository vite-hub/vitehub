import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"

import { collectWorkspaceAssetBundles, syncDiscoveredWorkspaces, writeWorkspaceAssetsRegistry } from "./build-assets.ts"
import { normalizeWorkspaceOptions } from "./config.ts"
import { createWorkspaceManifest, createWorkspaceVirtualRegistryContents, discoverViteWorkspaceDefinitions } from "./discovery.ts"
import { createWorkspaceTypeAugmentation } from "./generated-types.ts"
import workspaceNitroModule from "./nitro/module.ts"

import type { NitroModule } from "nitro/types"
import type { HmrContext, Plugin, ResolvedConfig, ViteDevServer } from "vite"
import type { WorkspaceModuleOptions } from "./types.ts"

const WORKSPACE_PACKAGE_NAME = "@vitehub/workspace"
const WORKSPACES_ID = "virtual:vitehub/workspaces"
const WORKSPACE_PREFIX = "virtual:vitehub/workspaces/"
const WORKSPACE_ASSETS_REGISTRY_ID = "#vitehub-workspace-assets-registry"
const WORKSPACE_REGISTRY_ID = "#vitehub-workspace-registry"
const RESOLVED_WORKSPACES_ID = `\0${WORKSPACES_ID}`
const RESOLVED_WORKSPACE_PREFIX = `\0${WORKSPACE_PREFIX}`
const RESOLVED_WORKSPACE_REGISTRY_ID = `\0${WORKSPACE_REGISTRY_ID}`
const mergeNoExternal = createNoExternalMerger(WORKSPACE_PACKAGE_NAME)

export interface WorkspaceVitePluginAPI {
  getWorkspaces: () => Array<{ name: string }>
}

export type WorkspaceVitePlugin = Plugin & { api: WorkspaceVitePluginAPI, nitro: NitroModule }

function ambientTypesPath(root: string) {
  return existsSync(resolve(root, "src"))
    ? resolve(root, "src", "vitehub-workspace.d.ts")
    : resolve(root, "vitehub-workspace.d.ts")
}

export function hubWorkspace(_options?: WorkspaceModuleOptions): WorkspaceVitePlugin {
  let resolved: ResolvedConfig | undefined
  let resolvedOptions: ReturnType<typeof normalizeWorkspaceOptions> = false
  let assetsRegistryFile: string | undefined
  let manifest: Awaited<ReturnType<typeof createWorkspaceManifest>> = { workspaces: [] }
  let registryContents = "export default {}\n"
  let server: ViteDevServer | undefined

  async function refreshManifest(root: string) {
    const definitions = discoverViteWorkspaceDefinitions(root)
    manifest = await createWorkspaceManifest(definitions)
    registryContents = createWorkspaceVirtualRegistryContents(definitions)
    const dtsPath = ambientTypesPath(root)
    await mkdir(dirname(dtsPath), { recursive: true })
    await writeFile(dtsPath, createWorkspaceTypeAugmentation(definitions), "utf8")
  }

  async function maybeRefreshTypesForFile(root: string, file: string) {
    if (!/\.workspace\.(?:c|m)?[jt]s$/i.test(file) && !/[\\/](?:server[\\/])?workspaces(?:[\\/]|$)/.test(file)) return
    await refreshManifest(root)
    server?.moduleGraph.invalidateAll()
  }

  return {
    name: "@vitehub/workspace/vite",
    api: {
      getWorkspaces: () => manifest.workspaces,
    },
    nitro: workspaceNitroModule,
    async configResolved(config) {
      resolved = config
      if (config.command !== "build")
        process.env.VITEHUB_WORKSPACE_DEV = "true"
      else
        delete process.env.VITEHUB_WORKSPACE_DEV
      resolvedOptions = normalizeWorkspaceOptions(_options ?? (config as ResolvedConfig & { workspace?: false | WorkspaceModuleOptions }).workspace, {
        dev: config.command !== "build",
        env: process.env,
        hosting: process.env.VITEHUB_HOSTING,
        rootDir: config.root,
      })
      assetsRegistryFile = resolve(config.root, ".vitehub/vite-runtime/workspace/assets/registry.mjs")
      await writeWorkspaceAssetsRegistry(assetsRegistryFile, [])
      await refreshManifest(config.root)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: {
          noExternal: mergeNoExternal(config.resolve?.noExternal),
        },
      }
    },
    async buildStart() {
      if (!resolved) return
      await refreshManifest(resolved.root)
      if (resolved.command !== "build" || !assetsRegistryFile) return

      const definitions = discoverViteWorkspaceDefinitions(resolved.root)
      const workspaces = await syncDiscoveredWorkspaces(definitions, resolved.root, resolvedOptions)
      await writeWorkspaceAssetsRegistry(assetsRegistryFile, await collectWorkspaceAssetBundles(workspaces))
    },
    configureServer(devServer) {
      server = devServer
      const refresh = async (file: string) => await maybeRefreshTypesForFile(devServer.config.root, file)
      devServer.watcher.on("add", refresh)
      devServer.watcher.on("unlink", refresh)
    },
    async handleHotUpdate(ctx: HmrContext) {
      if (!resolved) return
      await maybeRefreshTypesForFile(resolved.root, ctx.file)
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
