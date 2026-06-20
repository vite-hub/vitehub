import { resolve } from "node:path"

import { isPlainObject } from "@vite-hub/internal/object"

import { normalizeWorkspaceStoreOptions } from "./storage/provider.ts"

import type {
  ResolvedWorkspaceModuleOptions,
  WorkspaceModuleOptions,
} from "./core/types.ts"
import type { WorkspaceResolutionInput } from "./storage/provider.ts"

const workspaceConfigKeys = new Set([
  "assets",
  "projectRoot",
  "root",
  "store",
])

export {
  MASKED_WORKSPACE_RUNTIME_VALUE,
  hasVercelWorkspaceBlobEnv,
  isMaskedWorkspaceRuntimeValue,
  normalizeWorkspaceStoreOptions,
  resolveCloudflareArtifactsStore,
  resolveGitHubWorkspaceStore,
  resolveRuntimeVercelBlobWorkspaceStore,
  resolveVercelBlobWorkspaceStore,
} from "./storage/provider.ts"

export function normalizeWorkspaceOptions(
  options: false | WorkspaceModuleOptions | undefined,
  input: WorkspaceResolutionInput = {},
): false | ResolvedWorkspaceModuleOptions {
  if (options === false) return false
  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw new TypeError("`workspace` must be a plain object.")
  }

  const resolvedOptions = (options || {}) as WorkspaceModuleOptions
  const unsupported = Object.keys(resolvedOptions).filter(key => !workspaceConfigKeys.has(key))
  if (unsupported.length) {
    throw new TypeError(`[vitehub] workspace config does not support option${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}.`)
  }

  const rootDir = input.rootDir || process.cwd()
  const root = resolvedOptions.root || ".vitehub/workspaces"
  return {
    assets: resolvedOptions.assets,
    root: resolve(rootDir, root),
    store: normalizeWorkspaceStoreOptions(resolvedOptions.store, input) || { provider: "local" },
  }
}
