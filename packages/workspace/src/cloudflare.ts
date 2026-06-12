import { resolve } from "node:path"

import { resolveCloudflareArtifactsStore } from "./config.ts"
import { WorkspaceError } from "./core/errors.ts"
import { createCloudflareArtifactsWorkspaceStore } from "./providers/cloudflare/artifacts-store.ts"
import { setWorkspaceHostedStoreLoader } from "./runtime/hosted-store-loader.ts"
import { setWorkspaceRuntimeConfig } from "./runtime/config.ts"

import type {
  CloudflareArtifactsWorkspaceStoreOptions,
  ResolvedWorkspaceModuleOptions,
} from "./core/types.ts"

export interface CloudflareWorkspaceRuntimeOptions {
  assets?: boolean | string[]
  env?: Record<string, string | undefined>
  root?: string
  store?: Partial<CloudflareArtifactsWorkspaceStoreOptions>
}

export function configureCloudflareWorkspaceRuntime(options: CloudflareWorkspaceRuntimeOptions = {}): ResolvedWorkspaceModuleOptions {
  const root = resolve(process.cwd(), options.root || ".vitehub/workspaces")
  const store = resolveCloudflareArtifactsStore(options.store, options.env)
  const config: ResolvedWorkspaceModuleOptions = {
    assets: options.assets,
    root,
    store,
  }

  setWorkspaceHostedStoreLoader((storeOptions, workspaceName) => {
    if (storeOptions.provider !== "cloudflare-artifacts") {
      throw new WorkspaceError(`[vitehub] Cloudflare workspace runtime cannot load hosted store "${storeOptions.provider}".`)
    }
    return createCloudflareArtifactsWorkspaceStore(storeOptions, workspaceName)
  })
  setWorkspaceRuntimeConfig(config)
  return config
}

export { createCloudflareArtifactsWorkspaceStore }
export type { CloudflareArtifactsWorkspaceStoreOptions }
