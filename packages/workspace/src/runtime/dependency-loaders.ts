const sandboxPackageSpecifier = "@vite-hub/sandbox"
const sandboxRuntimeStateSpecifier = "@vite-hub/sandbox/runtime/state"
const shellWorkspaceSpecifier = "@vite-hub/shell/workspace"

export interface WorkspaceDependencyRuntimeLoaders {
  sandbox: () => Promise<unknown>
  sandboxRuntimeState: () => Promise<unknown>
  shellWorkspace: () => Promise<unknown>
}

const defaultWorkspaceDependencyRuntimeLoaders: WorkspaceDependencyRuntimeLoaders = {
  sandbox: () => import(/* @vite-ignore */ sandboxPackageSpecifier),
  sandboxRuntimeState: () => import(/* @vite-ignore */ sandboxRuntimeStateSpecifier),
  shellWorkspace: () => import(/* @vite-ignore */ shellWorkspaceSpecifier),
}

const workspaceDependencyRuntimeLoadersKey = Symbol.for("vitehub.workspace.dependencyRuntimeLoaders")

type WorkspaceDependencyRuntimeLoadersGlobal = typeof globalThis & Record<symbol, WorkspaceDependencyRuntimeLoaders | undefined>

function workspaceDependencyRuntimeLoadersGlobal(): WorkspaceDependencyRuntimeLoadersGlobal {
  return globalThis as WorkspaceDependencyRuntimeLoadersGlobal
}

export function setWorkspaceDependencyRuntimeLoaders(loaders: Partial<WorkspaceDependencyRuntimeLoaders> | undefined): void {
  workspaceDependencyRuntimeLoadersGlobal()[workspaceDependencyRuntimeLoadersKey] = loaders
    ? { ...defaultWorkspaceDependencyRuntimeLoaders, ...loaders }
    : undefined
}

export function getWorkspaceDependencyRuntimeLoaders(): WorkspaceDependencyRuntimeLoaders {
  return workspaceDependencyRuntimeLoadersGlobal()[workspaceDependencyRuntimeLoadersKey] ?? defaultWorkspaceDependencyRuntimeLoaders
}

export function loadWorkspaceSandboxModule(): Promise<unknown> {
  return getWorkspaceDependencyRuntimeLoaders().sandbox()
}

export function loadWorkspaceSandboxRuntimeStateModule(): Promise<unknown> {
  return getWorkspaceDependencyRuntimeLoaders().sandboxRuntimeState()
}

export function loadWorkspaceShellModule(): Promise<unknown> {
  return getWorkspaceDependencyRuntimeLoaders().shellWorkspace()
}
