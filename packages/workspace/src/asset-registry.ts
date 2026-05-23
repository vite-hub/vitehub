import { WorkspaceNotFoundError } from "./core/errors.ts"
import runtimeAssetsRegistry from "#vitehub-workspace-assets-registry"

import type { WorkspaceAssetPath, WorkspaceAssets, WorkspaceAssetsRegistry, WorkspaceName } from "./core/types.ts"

let assetsRegistry: WorkspaceAssetsRegistry = runtimeAssetsRegistry

export function setWorkspaceAssetsRegistry(registry: WorkspaceAssetsRegistry): void {
  assetsRegistry = registry
}

export function resetWorkspaceAssetsRegistry(): void {
  assetsRegistry = runtimeAssetsRegistry
}

export function useWorkspaceAssets<Name extends WorkspaceName>(name: Name): WorkspaceAssets<WorkspaceAssetPath<Name>> {
  const assets = assetsRegistry[name]
  if (!assets) throw new WorkspaceNotFoundError(name)
  return assets as WorkspaceAssets<WorkspaceAssetPath<Name>>
}
