import { resolve } from "node:path"

import {
  resolveCloudflareArtifactsStore,
  resolveGitHubWorkspaceStore,
} from "./config.ts"
import { workspaceError } from "./core/errors.ts"
import { createCloudflareArtifactsWorkspaceStore } from "./providers/cloudflare/artifacts-store.ts"
import { createGitHubWorkspaceStore } from "./providers/github/store.ts"
import { setWorkspaceRuntimeConfig } from "./runtime/config.ts"
import { getWorkspaceHostedStoreLoader, setWorkspaceHostedStoreLoader } from "./runtime/hosted-store-loader.ts"

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
  const existingWorkspaceHostedStoreLoader = getWorkspaceHostedStoreLoader()
  setWorkspaceHostedStoreLoader((storeOptions, workspaceName) => {
    if (storeOptions.provider === "cloudflare-artifacts") {
      return createCloudflareArtifactsWorkspaceStore(storeOptions, workspaceName)
    }
    if (storeOptions.provider === "github") return createGitHubWorkspaceStore(storeOptions, workspaceName)
    if (existingWorkspaceHostedStoreLoader) return existingWorkspaceHostedStoreLoader(storeOptions, workspaceName)
    throw workspaceError("[vitehub] Hosted workspace runtime cannot load unsupported hosted store.")
  })
}

export function configureHostedWorkspaceRuntime(options: HostedWorkspaceRuntimeOptions = {}): ResolvedWorkspaceModuleOptions {
  const root = resolve(process.cwd(), options.root || ".vitehub/workspaces")
  const store = options.store?.provider === "github"
    ? resolveGitHubWorkspaceStore(options.store, options.env || {}, { runtime: true })
    : options.store?.provider === "vercel-blob"
      ? undefined
      : resolveCloudflareArtifactsStore(options.store, options.env)
  if (!store) {
    throw workspaceError("[vitehub] Vercel Blob hosted workspace runtime must use @vite-hub/workspace/internal/runtime/hosted-vercel-blob.")
  }
  const config: ResolvedWorkspaceModuleOptions = {
    assets: options.assets,
    root,
    store,
  }

  installHostedWorkspaceRuntime()
  setWorkspaceRuntimeConfig(config)
  return config
}

export type { CloudflareArtifactsWorkspaceStoreOptions, GitHubWorkspaceStoreOptions, VercelBlobWorkspaceStoreOptions }
