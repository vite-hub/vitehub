import { registerWorkspace, resolveRegisteredWorkspaceDefinition, setWorkspaceRegistry, type WorkspaceRegistry } from "../core/registry.ts"
import { setWorkspaceAssetsRegistry } from "../asset-registry.ts"
import { invalidateCachedWorkspaceStore } from "../core/workspace-cache.ts"
import type { WorkspaceAssetsRegistry } from "../core/types.ts"
export { setActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
export { useWorkspace } from "../core/use.ts"
export type { ReadonlyWorkspaceFacade, UseWorkspaceOptions, WritableWorkspaceFacade } from "../core/use.ts"
export { resetWorkspaceStoreCache } from "../core/workspace-cache.ts"
export { getWorkspaceHostedStoreLoader, setWorkspaceHostedStoreLoader } from "./hosted-store-loader.ts"
export { getWorkspaceRuntimeConfig, setWorkspaceRuntimeConfig } from "./config.ts"
export { registerWorkspace }
export { resolveRegisteredWorkspaceDefinition }

export async function invalidateWorkspaceStore(name: string): Promise<void> {
  invalidateCachedWorkspaceStore(await resolveRegisteredWorkspaceDefinition(name))
}

export function setWorkspaceRuntimeRegistry(registry: WorkspaceRegistry): void {
  setWorkspaceRegistry(registry)
}

export function setWorkspaceRuntimeAssetsRegistry(registry: WorkspaceAssetsRegistry): void {
  setWorkspaceAssetsRegistry(registry)
}
