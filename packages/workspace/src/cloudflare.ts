import type {
  CloudflareArtifactsWorkspaceStoreOptions,
  GitHubWorkspaceStoreOptions,
  ResolvedWorkspaceModuleOptions,
} from "./core/types.ts"
export {
  configureHostedWorkspaceRuntime as configureCloudflareWorkspaceRuntime,
} from "./hosted.ts"
export { createCloudflareArtifactsWorkspaceStore } from "./providers/cloudflare/artifacts-store.ts"

export type CloudflareWorkspaceRuntimeStoreOptions =
  | Partial<CloudflareArtifactsWorkspaceStoreOptions>
  | (Partial<GitHubWorkspaceStoreOptions> & { provider: "github" })

export interface CloudflareWorkspaceRuntimeOptions {
  assets?: boolean | string[]
  env?: Record<string, string | undefined>
  root?: string
  store?: CloudflareWorkspaceRuntimeStoreOptions
}

export type { CloudflareArtifactsWorkspaceStoreOptions, GitHubWorkspaceStoreOptions }
export type { ResolvedWorkspaceModuleOptions }
