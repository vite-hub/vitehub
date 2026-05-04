import type { CloudflareArtifactsWorkspaceStoreOptions, VercelBlobWorkspaceStoreOptions, WorkspaceStore } from "../types.ts"

export type HostedWorkspaceStoreOptions = CloudflareArtifactsWorkspaceStoreOptions | VercelBlobWorkspaceStoreOptions
export type WorkspaceHostedStoreLoader = (options: HostedWorkspaceStoreOptions, workspaceName: string) => WorkspaceStore

let workspaceHostedStoreLoader: WorkspaceHostedStoreLoader | undefined

export function setWorkspaceHostedStoreLoader(loader: WorkspaceHostedStoreLoader | undefined): void {
  workspaceHostedStoreLoader = loader
}

export function getWorkspaceHostedStoreLoader(): WorkspaceHostedStoreLoader | undefined {
  return workspaceHostedStoreLoader
}
