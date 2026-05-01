import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"

import { createWorkspaceManifest, createWorkspaceRegistryContents, discoverWorkspaceDefinitions } from "./discovery.ts"
import workspaceNitroModule from "./nitro/module.ts"

import type { NitroModule } from "nitro/types"
import type { Plugin, ResolvedConfig } from "vite"
import type { WorkspaceModuleOptions } from "./types.ts"

const WORKSPACE_PACKAGE_NAME = "@vitehub/workspace"
const WORKSPACES_ID = "virtual:vitehub/workspaces"
const WORKSPACE_PREFIX = "virtual:vitehub/workspaces/"
const WORKSPACE_REGISTRY_ID = "#vitehub-workspace-registry"
const RESOLVED_WORKSPACES_ID = `\0${WORKSPACES_ID}`
const RESOLVED_WORKSPACE_PREFIX = `\0${WORKSPACE_PREFIX}`
const RESOLVED_WORKSPACE_REGISTRY_ID = `\0${WORKSPACE_REGISTRY_ID}`
const mergeNoExternal = createNoExternalMerger(WORKSPACE_PACKAGE_NAME)

export interface WorkspaceVitePluginAPI {
  getWorkspaces: () => Array<{ name: string }>
}

export type WorkspaceVitePlugin = Plugin & { api: WorkspaceVitePluginAPI, nitro: NitroModule }

export function hubWorkspace(_options?: WorkspaceModuleOptions): WorkspaceVitePlugin {
  let resolved: ResolvedConfig | undefined
  let manifest: Awaited<ReturnType<typeof createWorkspaceManifest>> = { workspaces: [] }
  let registryContents = "export default {}\n"

  async function refreshManifest(root: string) {
    const definitions = discoverWorkspaceDefinitions(root)
    manifest = await createWorkspaceManifest(definitions)
    registryContents = createWorkspaceRegistryContents(definitions)
  }

  return {
    name: "@vitehub/workspace/vite",
    api: {
      getWorkspaces: () => manifest.workspaces,
    },
    nitro: workspaceNitroModule,
    async configResolved(config) {
      resolved = config
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
      if (resolved) await refreshManifest(resolved.root)
    },
    resolveId(id) {
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
