import type { CloudflareArtifactsWorkspaceStoreOptions, GitHubWorkspaceStoreOptions, VercelBlobWorkspaceStoreOptions, WorkspaceStore } from "../core/types.ts"

export type HostedWorkspaceStoreOptions = CloudflareArtifactsWorkspaceStoreOptions | GitHubWorkspaceStoreOptions | VercelBlobWorkspaceStoreOptions
export type WorkspaceHostedStoreLoader = (options: HostedWorkspaceStoreOptions, workspaceName: string) => WorkspaceStore

let workspaceHostedStoreLoader: WorkspaceHostedStoreLoader | undefined

export function setWorkspaceHostedStoreLoader(loader: WorkspaceHostedStoreLoader | undefined): void {
  workspaceHostedStoreLoader = loader
}

export function getWorkspaceHostedStoreLoader(): WorkspaceHostedStoreLoader | undefined {
  return workspaceHostedStoreLoader
}
