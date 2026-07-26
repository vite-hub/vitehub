import { workspaceError } from "../core/errors.ts"

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

export async function loadWorkspaceShellModule(): Promise<unknown> {
  try {
    return await getWorkspaceDependencyRuntimeLoaders().shellWorkspace()
  }
  catch (error) {
    if (isMissingWorkspaceShellError(error)) {
      throw workspaceError("[vitehub] Install @vite-hub/shell to use Workspace Tools shell commands.", { cause: error })
    }
    throw error
  }
}

function isMissingWorkspaceShellError(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false
  return error.message.includes("Cannot find package '@vite-hub/shell'")
    || error.message.includes("Cannot find module '@vite-hub/shell'")
    || error.message.includes("Cannot find module '@vite-hub/shell/workspace'")
    || (error.message.includes("tried to access @vite-hub/shell")
      && (error.message.includes("isn't declared") || error.message.includes("isn't provided")))
}
