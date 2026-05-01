import { defu } from "defu"
import { resolve } from "node:path"

import { readEnv, trimmed } from "@vitehub/internal/env"
import { isPlainObject } from "@vitehub/internal/object"

import type {
  CloudflareArtifactsWorkspaceStoreOptions,
  ResolvedWorkspaceModuleOptions,
  VercelBlobWorkspaceStoreOptions,
  WorkspaceModuleOptions,
  WorkspaceStore,
  WorkspaceStoreOptions,
} from "./types.ts"

export interface WorkspaceResolutionInput {
  env?: Record<string, string | undefined>
  hosting?: string
  rootDir?: string
}

export const MASKED_WORKSPACE_RUNTIME_VALUE = "********"
type ResolvedWorkspaceStoreOptions = Exclude<WorkspaceStoreOptions, WorkspaceStore>

function workspaceRepoName(name: string | undefined) {
  return name ? name.replace(/[^a-zA-Z0-9_.-]/g, "-") : undefined
}

export function resolveCloudflareArtifactsStore(
  config: Partial<CloudflareArtifactsWorkspaceStoreOptions> = {},
  env: Record<string, string | undefined> = process.env,
): CloudflareArtifactsWorkspaceStoreOptions {
  const repoPrefix = trimmed(config.repoPrefix)
    ?? readEnv(env, "WORKSPACE_ARTIFACTS_REPO_PREFIX", "VITEHUB_WORKSPACE_ARTIFACTS_REPO_PREFIX")
    ?? "vitehub-workspace-"
  const repo = trimmed(config.repo)
    ?? workspaceRepoName(readEnv(env, "WORKSPACE_ARTIFACTS_REPO", "VITEHUB_WORKSPACE_ARTIFACTS_REPO"))

  return defu(
    {
      binding: trimmed(config.binding) ?? readEnv(env, "WORKSPACE_ARTIFACTS_BINDING", "VITEHUB_WORKSPACE_ARTIFACTS_BINDING"),
      branch: trimmed(config.branch) ?? readEnv(env, "WORKSPACE_ARTIFACTS_BRANCH", "VITEHUB_WORKSPACE_ARTIFACTS_BRANCH"),
      namespace: trimmed(config.namespace) ?? readEnv(env, "WORKSPACE_ARTIFACTS_NAMESPACE", "VITEHUB_WORKSPACE_ARTIFACTS_NAMESPACE"),
      repo,
      repoPrefix,
    },
    {
      binding: "WORKSPACE_ARTIFACTS",
      branch: "main",
      namespace: "vitehub",
      provider: "cloudflare-artifacts" as const,
    },
  )
}

export function resolveVercelBlobWorkspaceStore(
  config: Partial<VercelBlobWorkspaceStoreOptions> = {},
  env: Record<string, string | undefined> = process.env,
): VercelBlobWorkspaceStoreOptions {
  return {
    access: config.access ?? "private",
    prefix: trimmed(config.prefix) ?? readEnv(env, "WORKSPACE_BLOB_PREFIX", "VITEHUB_WORKSPACE_BLOB_PREFIX") ?? ".vitehub/workspaces",
    provider: "vercel-blob",
    token: trimmed(config.token) ?? MASKED_WORKSPACE_RUNTIME_VALUE,
  }
}

export function hasVercelWorkspaceBlobEnv(env: Record<string, string | undefined>): boolean {
  return Boolean(readEnv(env, "BLOB_READ_WRITE_TOKEN"))
}

export function normalizeWorkspaceStoreOptions(
  store: WorkspaceStoreOptions | undefined,
  input: WorkspaceResolutionInput = {},
): ResolvedWorkspaceStoreOptions | undefined {
  if (store && "readFile" in store) return

  const env = input.env || process.env
  const hosting = input.hosting || ""

  if (store?.provider === "cloudflare-artifacts") return resolveCloudflareArtifactsStore(store, env)
  if (store?.provider === "memory") return store
  if (store?.provider === "vercel-blob") return resolveVercelBlobWorkspaceStore(store, env)
  if (store?.provider === "local" || store?.root) return defu(store, { provider: "local" as const }) as ResolvedWorkspaceStoreOptions

  if (hosting.includes("cloudflare")) return resolveCloudflareArtifactsStore({}, env)
  if (hosting.includes("vercel") || hasVercelWorkspaceBlobEnv(env)) return resolveVercelBlobWorkspaceStore({}, env)

  return { provider: "local" as const }
}

export function normalizeWorkspaceOptions(
  options: false | WorkspaceModuleOptions | undefined,
  input: WorkspaceResolutionInput = {},
): false | ResolvedWorkspaceModuleOptions {
  if (options === false) return false
  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw new TypeError("`workspace` must be a plain object.")
  }

  const resolvedOptions = (options || {}) as WorkspaceModuleOptions
  const rootDir = input.rootDir || process.cwd()
  const root = resolvedOptions.root || ".vitehub/workspaces"
  return {
    root: resolve(rootDir, root),
    store: normalizeWorkspaceStoreOptions(resolvedOptions.store, input) || { provider: "local" },
    syncOnBuild: resolvedOptions.syncOnBuild,
  }
}

export function isMaskedWorkspaceRuntimeValue(value: string | undefined): boolean {
  return !value || value === MASKED_WORKSPACE_RUNTIME_VALUE
}

export function resolveRuntimeVercelBlobWorkspaceStore(
  config: VercelBlobWorkspaceStoreOptions,
  env: Record<string, string | undefined>,
): VercelBlobWorkspaceStoreOptions {
  const token = isMaskedWorkspaceRuntimeValue(config.token)
    ? readEnv(env, "BLOB_READ_WRITE_TOKEN") || config.token
    : config.token

  if (isMaskedWorkspaceRuntimeValue(token)) {
    throw new Error("Missing runtime environment variable `BLOB_READ_WRITE_TOKEN` for Vercel workspace Blob storage.")
  }

  return {
    ...config,
    token,
  }
}
