import { workspaceNotFoundError } from "./core/errors.ts"
import runtimeAssetsRegistry from "#vitehub-workspace-assets-registry"

import type { WorkspaceAssetPath, WorkspaceAssets, WorkspaceAssetsRegistry, WorkspaceName } from "./core/types.ts"

const workspaceAssetsRegistryKey = Symbol.for("vitehub.workspace.assetsRegistry")

type WorkspaceAssetsRegistryGlobal = typeof globalThis & Record<symbol, WorkspaceAssetsRegistry | undefined>

function workspaceAssetsRegistryGlobal(): WorkspaceAssetsRegistryGlobal {
  const scope = globalThis as WorkspaceAssetsRegistryGlobal
  scope[workspaceAssetsRegistryKey] ??= runtimeAssetsRegistry
  return scope
}

export function setWorkspaceAssetsRegistry(registry: WorkspaceAssetsRegistry): void {
  workspaceAssetsRegistryGlobal()[workspaceAssetsRegistryKey] = registry
}

export function resetWorkspaceAssetsRegistry(): void {
  workspaceAssetsRegistryGlobal()[workspaceAssetsRegistryKey] = runtimeAssetsRegistry
}

export function useWorkspaceAssets<Name extends WorkspaceName>(name: Name): WorkspaceAssets<WorkspaceAssetPath<Name>> {
  const assets = workspaceAssetsRegistryGlobal()[workspaceAssetsRegistryKey]?.[name]
  if (!assets) throw workspaceNotFoundError(name)
  return assets as WorkspaceAssets<WorkspaceAssetPath<Name>>
}
