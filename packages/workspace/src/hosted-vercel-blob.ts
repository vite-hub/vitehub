import { resolve } from "node:path"

import { resolveVercelBlobWorkspaceStore } from "./config.ts"
import { workspaceError } from "./core/errors.ts"
import { createVercelBlobWorkspaceStore } from "./providers/vercel/blob-store.ts"
import { setWorkspaceRuntimeConfig } from "./runtime/config.ts"
import { getWorkspaceHostedStoreLoader, setWorkspaceHostedStoreLoader } from "./runtime/hosted-store-loader.ts"

import type { ResolvedWorkspaceModuleOptions, VercelBlobWorkspaceStoreOptions } from "./core/types.ts"

export interface HostedVercelBlobWorkspaceRuntimeOptions {
  assets?: boolean | string[]
  env?: Record<string, string | undefined>
  root?: string
  store?: Partial<VercelBlobWorkspaceStoreOptions> & { provider: "vercel-blob" }
}

export function installHostedVercelBlobWorkspaceRuntime(): void {
  const existingWorkspaceHostedStoreLoader = getWorkspaceHostedStoreLoader()
  setWorkspaceHostedStoreLoader((storeOptions, workspaceName) => {
    if (storeOptions.provider === "vercel-blob") return createVercelBlobWorkspaceStore(storeOptions, workspaceName)
    if (existingWorkspaceHostedStoreLoader) return existingWorkspaceHostedStoreLoader(storeOptions, workspaceName)
    throw workspaceError("[vitehub] Vercel Blob hosted workspace runtime cannot load unsupported hosted store.")
  })
}

export function configureHostedVercelBlobWorkspaceRuntime(options: HostedVercelBlobWorkspaceRuntimeOptions = {}): ResolvedWorkspaceModuleOptions {
  const root = resolve(process.cwd(), options.root || ".vitehub/workspaces")
  const config: ResolvedWorkspaceModuleOptions = {
    assets: options.assets,
    root,
    store: resolveVercelBlobWorkspaceStore(options.store, options.env),
  }

  installHostedVercelBlobWorkspaceRuntime()
  setWorkspaceRuntimeConfig(config)
  return config
}

export type { VercelBlobWorkspaceStoreOptions }
