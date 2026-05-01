import { setWorkspaceRegistry, type WorkspaceRegistry } from "../registry.ts"
import type { ResolvedWorkspaceModuleOptions } from "../types.ts"

let workspaceRuntimeConfig: false | ResolvedWorkspaceModuleOptions = false

export function setWorkspaceRuntimeConfig(config: false | ResolvedWorkspaceModuleOptions): void {
  workspaceRuntimeConfig = config
}

export function getWorkspaceRuntimeConfig(): false | ResolvedWorkspaceModuleOptions {
  return workspaceRuntimeConfig
}

export function setWorkspaceRuntimeRegistry(registry: WorkspaceRegistry): void {
  setWorkspaceRegistry(registry)
}
