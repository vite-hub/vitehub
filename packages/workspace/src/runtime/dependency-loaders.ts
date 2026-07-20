const shellWorkspaceSpecifier = "@vite-hub/shell/workspace"

export interface WorkspaceDependencyRuntimeLoaders {
  shellWorkspace: () => Promise<unknown>
}

const defaultWorkspaceDependencyRuntimeLoaders: WorkspaceDependencyRuntimeLoaders = {
  shellWorkspace: () => import(/* @vite-ignore */ shellWorkspaceSpecifier),
}

function workspaceDependencyRuntimeLoadersKey(): symbol {
  return Symbol.for("vitehub.workspace.dependencyRuntimeLoaders")
}

type WorkspaceDependencyRuntimeLoadersGlobal = typeof globalThis & Record<symbol, WorkspaceDependencyRuntimeLoaders | undefined>

function workspaceDependencyRuntimeLoadersGlobal(): WorkspaceDependencyRuntimeLoadersGlobal {
  return globalThis as WorkspaceDependencyRuntimeLoadersGlobal
}

export function setWorkspaceDependencyRuntimeLoaders(loaders: Partial<WorkspaceDependencyRuntimeLoaders> | undefined): void {
  workspaceDependencyRuntimeLoadersGlobal()[workspaceDependencyRuntimeLoadersKey()] = loaders
    ? { ...defaultWorkspaceDependencyRuntimeLoaders, ...loaders }
    : undefined
}

export function getWorkspaceDependencyRuntimeLoaders(): WorkspaceDependencyRuntimeLoaders {
  return workspaceDependencyRuntimeLoadersGlobal()[workspaceDependencyRuntimeLoadersKey()] ?? defaultWorkspaceDependencyRuntimeLoaders
}

export function loadWorkspaceShellModule(): Promise<unknown> {
  return getWorkspaceDependencyRuntimeLoaders().shellWorkspace()
}
