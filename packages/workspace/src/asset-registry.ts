import { WorkspaceNotFoundError } from "./errors.ts"
import runtimeAssetsRegistry from "#vitehub-workspace-assets-registry"

import type { WorkspaceAssets, WorkspaceAssetsRegistry } from "./types.ts"

let assetsRegistry: WorkspaceAssetsRegistry = runtimeAssetsRegistry

export function setWorkspaceAssetsRegistry(registry: WorkspaceAssetsRegistry): void {
  assetsRegistry = registry
}

export function resetWorkspaceAssetsRegistry(): void {
  assetsRegistry = runtimeAssetsRegistry
}

export function useWorkspaceAssets(name: string): WorkspaceAssets {
  const assets = assetsRegistry[name]
  if (!assets) throw new WorkspaceNotFoundError(name)
  return assets
}
