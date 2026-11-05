import { resolve } from "node:path"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"

import {
  syncDiscoveredWorkspaceAssetBundles,
  writeWorkspaceAssetsRegistry,
} from "./assets.ts"
import {
  createWorkspaceManifest,
  createWorkspaceVirtualRegistryContents,
} from "./discovery.ts"

import type { DiscoveredWorkspaceDefinition } from "./discovery.ts"
import type { ResolvedWorkspaceModuleOptions } from "../core/types.ts"

export interface WorkspaceBuildState {
  manifest: Awaited<ReturnType<typeof createWorkspaceManifest>>
  registryContents: string
}

export async function refreshWorkspaceBuildState(root: string, definitions: DiscoveredWorkspaceDefinition[]): Promise<WorkspaceBuildState> {
  const state: WorkspaceBuildState = {
    manifest: await createWorkspaceManifest(definitions),
    registryContents: createWorkspaceVirtualRegistryContents(definitions),
  }
  await writeFileIfChanged(resolve(root, ".vitehub", "types", "workspace.d.ts"), createWorkspaceTypeAugmentation(definitions))
  return state
}

export async function initializeWorkspaceAssetRegistry(assetsRegistryFile: string): Promise<void> {
  await writeWorkspaceAssetsRegistry(assetsRegistryFile, [])
}

export async function syncWorkspaceBuildAssets(
  definitions: DiscoveredWorkspaceDefinition[],
  rootDir: string,
  options: false | ResolvedWorkspaceModuleOptions,
  assetsRegistryFile: string,
): Promise<void> {
  const syncedBundles = await syncDiscoveredWorkspaceAssetBundles(definitions, rootDir, options)
  await writeWorkspaceAssetsRegistry(assetsRegistryFile, syncedBundles.sort((a, b) => a.name.localeCompare(b.name)))
}

function createWorkspaceTypeAugmentation(definitions: Array<{ name: string, path: string }>): string {
  const names = [...new Set(definitions.map(definition => definition.name))].sort()
  const nameProperties = names.map(name => `    ${JSON.stringify(name)}: true`)

  return [
    "declare global {",
    "  interface ViteHubWorkspaceNameMap {",
    ...(nameProperties.length ? nameProperties : ["    __vitehub_no_workspaces__?: never"]),
    "  }",
    "",
    "  interface ViteHubWorkspaceAssetMap {",
    "    __vitehub_no_workspace_assets__?: never",
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}
