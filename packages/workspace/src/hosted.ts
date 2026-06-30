import { resolve } from "node:path"

import {
  resolveCloudflareArtifactsStore,
  resolveGitHubWorkspaceStore,
  resolveVercelBlobWorkspaceStore,
} from "./config.ts"
import { WorkspaceError } from "./core/errors.ts"
import { createCloudflareArtifactsWorkspaceStore } from "./providers/cloudflare/artifacts-store.ts"
import { createGitHubWorkspaceStore } from "./providers/github/store.ts"
import { createVercelBlobWorkspaceStore } from "./providers/vercel/blob-store.ts"
import { setWorkspaceRuntimeConfig } from "./runtime/config.ts"
import { setWorkspaceHostedStoreLoader } from "./runtime/hosted-store-loader.ts"

import type {
  CloudflareArtifactsWorkspaceStoreOptions,
  GitHubWorkspaceStoreOptions,
  ResolvedWorkspaceModuleOptions,
  VercelBlobWorkspaceStoreOptions,
} from "./core/types.ts"

export type HostedWorkspaceRuntimeStoreOptions =
  | Partial<CloudflareArtifactsWorkspaceStoreOptions>
  | (Partial<GitHubWorkspaceStoreOptions> & { provider: "github" })
  | (Partial<VercelBlobWorkspaceStoreOptions> & { provider: "vercel-blob" })

export interface HostedWorkspaceRuntimeOptions {
  assets?: boolean | string[]
  env?: Record<string, string | undefined>
  root?: string
  store?: HostedWorkspaceRuntimeStoreOptions
}

export function installHostedWorkspaceRuntime(): void {
  setWorkspaceHostedStoreLoader((storeOptions, workspaceName) => {
    if (storeOptions.provider === "cloudflare-artifacts") {
      return createCloudflareArtifactsWorkspaceStore(storeOptions, workspaceName)
    }
    if (storeOptions.provider === "github") return createGitHubWorkspaceStore(storeOptions, workspaceName)
    if (storeOptions.provider === "vercel-blob") return createVercelBlobWorkspaceStore(storeOptions, workspaceName)
    throw new WorkspaceError("[vitehub] Hosted workspace runtime cannot load unsupported hosted store.")
  })
}

export function configureHostedWorkspaceRuntime(options: HostedWorkspaceRuntimeOptions = {}): ResolvedWorkspaceModuleOptions {
  const root = resolve(process.cwd(), options.root || ".vitehub/workspaces")
  const store = options.store?.provider === "github"
    ? resolveGitHubWorkspaceStore(options.store, options.env, { runtime: true })
    : options.store?.provider === "vercel-blob"
      ? resolveVercelBlobWorkspaceStore(options.store, options.env)
      : resolveCloudflareArtifactsStore(options.store, options.env)
  const config: ResolvedWorkspaceModuleOptions = {
    assets: options.assets,
    root,
    store,
  }

  installHostedWorkspaceRuntime()
  setWorkspaceRuntimeConfig(config)
  return config
}

export {
  createCloudflareArtifactsWorkspaceStore,
  createGitHubWorkspaceStore,
  createVercelBlobWorkspaceStore,
}
export type { CloudflareArtifactsWorkspaceStoreOptions, GitHubWorkspaceStoreOptions, VercelBlobWorkspaceStoreOptions }
