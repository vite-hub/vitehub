import { setWorkspaceRegistry, type WorkspaceRegistry } from "../registry.ts"
export { resetWorkspaceStoreCache } from "../workspace-cache.ts"
export { getWorkspaceHostedStoreLoader, setWorkspaceHostedStoreLoader } from "./hosted-store-loader.ts"
export { getWorkspaceRuntimeConfig, setWorkspaceRuntimeConfig } from "./config.ts"

export function setWorkspaceRuntimeRegistry(registry: WorkspaceRegistry): void {
  setWorkspaceRegistry(registry)
}
