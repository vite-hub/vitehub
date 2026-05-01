import { setWorkspaceRegistry, type WorkspaceRegistry } from "../registry.ts"
export { getWorkspaceRuntimeConfig, setWorkspaceRuntimeConfig } from "./config.ts"

export function setWorkspaceRuntimeRegistry(registry: WorkspaceRegistry): void {
  setWorkspaceRegistry(registry)
}
