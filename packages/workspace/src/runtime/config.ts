import type { ResolvedWorkspaceModuleOptions } from "../core/types.ts"

const workspaceRuntimeConfigKey = Symbol.for("vitehub.workspace.runtimeConfig")

type WorkspaceRuntimeConfigGlobal = typeof globalThis & Record<symbol, false | ResolvedWorkspaceModuleOptions | undefined>

function workspaceRuntimeConfigGlobal(): WorkspaceRuntimeConfigGlobal {
  const scope = globalThis as WorkspaceRuntimeConfigGlobal
  scope[workspaceRuntimeConfigKey] ??= false
  return scope
}

export function setWorkspaceRuntimeConfig(config: false | ResolvedWorkspaceModuleOptions): void {
  workspaceRuntimeConfigGlobal()[workspaceRuntimeConfigKey] = config
}

export function getWorkspaceRuntimeConfig(): false | ResolvedWorkspaceModuleOptions {
  return workspaceRuntimeConfigGlobal()[workspaceRuntimeConfigKey] ?? false
}
