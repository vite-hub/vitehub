import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { writeFileIfChanged } from "@vitehub/internal/definition-catalog"

import {
  collectDirectoryWorkspaceAssetBundles,
  shouldSyncWorkspace,
  syncDiscoveredWorkspaceAssetBundles,
  writeWorkspaceAssetsRegistry,
} from "./build-assets.ts"
import {
  createWorkspaceManifest,
  createWorkspaceRegistryContents,
  createWorkspaceVirtualRegistryContents,
} from "./discovery.ts"
import { createWorkspaceTypeAugmentation } from "./generated-types.ts"

import type { DiscoveredWorkspaceDefinition } from "./discovery.ts"
import type { ResolvedWorkspaceModuleOptions } from "./types.ts"

export interface WorkspaceBuildState {
  manifest: Awaited<ReturnType<typeof createWorkspaceManifest>>
  registryContents: string
}

export function workspaceAmbientTypesPath(root: string) {
  return existsSync(resolve(root, "src"))
    ? resolve(root, "src", "vitehub-workspace.d.ts")
    : resolve(root, "vitehub-workspace.d.ts")
}

export async function createWorkspaceBuildState(definitions: DiscoveredWorkspaceDefinition[]): Promise<WorkspaceBuildState> {
  return {
    manifest: await createWorkspaceManifest(definitions),
    registryContents: createWorkspaceVirtualRegistryContents(definitions),
  }
}

export async function refreshWorkspaceAmbientTypes(root: string, definitions: DiscoveredWorkspaceDefinition[]): Promise<void> {
  await writeFileIfChanged(workspaceAmbientTypesPath(root), createWorkspaceTypeAugmentation(definitions))
}

export async function refreshWorkspaceBuildState(root: string, definitions: DiscoveredWorkspaceDefinition[]): Promise<WorkspaceBuildState> {
  const state = await createWorkspaceBuildState(definitions)
  await refreshWorkspaceAmbientTypes(root, definitions)
  return state
}

export async function writeWorkspaceRuntimeRegistry(registryFile: string, definitions: DiscoveredWorkspaceDefinition[]): Promise<string> {
  await mkdir(dirname(registryFile), { recursive: true })
  await writeFile(registryFile, createWorkspaceRegistryContents(registryFile, definitions), "utf8")
  return registryFile
}

export async function initializeWorkspaceAssetRegistry(
  assetsRegistryFile: string,
  definitions: DiscoveredWorkspaceDefinition[] = [],
  rootDir = process.cwd(),
): Promise<void> {
  await writeWorkspaceAssetsRegistry(assetsRegistryFile, await collectDirectoryWorkspaceAssetBundles(definitions, rootDir))
}

export async function syncWorkspaceBuildAssets(
  definitions: DiscoveredWorkspaceDefinition[],
  rootDir: string,
  options: false | ResolvedWorkspaceModuleOptions,
  assetsRegistryFile: string,
): Promise<void> {
  const syncedBundles = await syncDiscoveredWorkspaceAssetBundles(definitions, rootDir, options)
  const syncedNames = new Set(syncedBundles.map(bundle => bundle.name))
  const selectedDefinitions = options ? definitions.filter(definition => shouldSyncWorkspace(options.syncOnBuild, definition.name)) : []
  const directoryBundles = (await collectDirectoryWorkspaceAssetBundles(selectedDefinitions, rootDir))
    .filter(bundle => !syncedNames.has(bundle.name))
  await writeWorkspaceAssetsRegistry(assetsRegistryFile, [...directoryBundles, ...syncedBundles])
}
