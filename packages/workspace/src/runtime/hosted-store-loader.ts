import type { CloudflareArtifactsWorkspaceStoreOptions, GitHubWorkspaceStoreOptions, VercelBlobWorkspaceStoreOptions, WorkspaceStore } from "../core/types.ts"

export type HostedWorkspaceStoreOptions = CloudflareArtifactsWorkspaceStoreOptions | GitHubWorkspaceStoreOptions | VercelBlobWorkspaceStoreOptions
export type WorkspaceHostedStoreLoader = (options: HostedWorkspaceStoreOptions, workspaceName: string) => WorkspaceStore

const workspaceHostedStoreLoaderKey = Symbol.for("vitehub.workspace.hostedStoreLoader")

type WorkspaceHostedStoreLoaderGlobal = typeof globalThis & Record<symbol, WorkspaceHostedStoreLoader | undefined>

function workspaceHostedStoreLoaderGlobal(): WorkspaceHostedStoreLoaderGlobal {
  return globalThis as WorkspaceHostedStoreLoaderGlobal
}

export function setWorkspaceHostedStoreLoader(loader: WorkspaceHostedStoreLoader | undefined): void {
  workspaceHostedStoreLoaderGlobal()[workspaceHostedStoreLoaderKey] = loader
}

export function getWorkspaceHostedStoreLoader(): WorkspaceHostedStoreLoader | undefined {
  return workspaceHostedStoreLoaderGlobal()[workspaceHostedStoreLoaderKey]
}
