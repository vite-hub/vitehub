import { resolve } from "node:path"

import { resolveCloudflareArtifactsStore, resolveGitHubWorkspaceStore } from "./config.ts"
import { WorkspaceError } from "./core/errors.ts"
import { createCloudflareArtifactsWorkspaceStore } from "./providers/cloudflare/artifacts-store.ts"
import { createGitHubWorkspaceStore } from "./providers/github/store.ts"
import { setWorkspaceHostedStoreLoader } from "./runtime/hosted-store-loader.ts"
import { setWorkspaceRuntimeConfig } from "./runtime/config.ts"

import type {
  CloudflareArtifactsWorkspaceStoreOptions,
  GitHubWorkspaceStoreOptions,
  ResolvedWorkspaceModuleOptions,
} from "./core/types.ts"

export type CloudflareWorkspaceRuntimeStoreOptions =
  | Partial<CloudflareArtifactsWorkspaceStoreOptions>
  | (Partial<GitHubWorkspaceStoreOptions> & { provider: "github" })

export interface CloudflareWorkspaceRuntimeOptions {
  assets?: boolean | string[]
  env?: Record<string, string | undefined>
  root?: string
  store?: CloudflareWorkspaceRuntimeStoreOptions
}

export function configureCloudflareWorkspaceRuntime(options: CloudflareWorkspaceRuntimeOptions = {}): ResolvedWorkspaceModuleOptions {
  const root = resolve(process.cwd(), options.root || ".vitehub/workspaces")
  const store = options.store?.provider === "github"
    ? resolveGitHubWorkspaceStore(options.store, options.env)
    : resolveCloudflareArtifactsStore(options.store, options.env)
  const config: ResolvedWorkspaceModuleOptions = {
    assets: options.assets,
    root,
    store,
  }

  setWorkspaceHostedStoreLoader((storeOptions, workspaceName) => {
    if (storeOptions.provider === "cloudflare-artifacts") {
      return createCloudflareArtifactsWorkspaceStore(storeOptions, workspaceName)
    }
    if (storeOptions.provider === "github") return createGitHubWorkspaceStore(storeOptions, workspaceName)
    throw new WorkspaceError(`[vitehub] Cloudflare workspace runtime cannot load hosted store "${storeOptions.provider}".`)
  })
  setWorkspaceRuntimeConfig(config)
  return config
}

export { createCloudflareArtifactsWorkspaceStore }
export type { CloudflareArtifactsWorkspaceStoreOptions, GitHubWorkspaceStoreOptions }
