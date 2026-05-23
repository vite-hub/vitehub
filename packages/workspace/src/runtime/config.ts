import type { ResolvedWorkspaceModuleOptions } from "../core/types.ts"

let workspaceRuntimeConfig: false | ResolvedWorkspaceModuleOptions = false

export function setWorkspaceRuntimeConfig(config: false | ResolvedWorkspaceModuleOptions): void {
  workspaceRuntimeConfig = config
}

export function getWorkspaceRuntimeConfig(): false | ResolvedWorkspaceModuleOptions {
  return workspaceRuntimeConfig
}
