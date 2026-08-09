import { defu } from "defu"
import { resolve } from "node:path"

import { readEnv, trimmed } from "@vite-hub/internal/env"

import { workspaceError } from "../core/errors.ts"
import { createGitHubWorkspaceStore } from "../providers/github/store.ts"
import { getWorkspaceRuntimeConfig } from "../runtime/config.ts"
import { getWorkspaceHostedStoreLoader } from "../runtime/hosted-store-loader.ts"
import { createLocalWorkspaceStore } from "./local.ts"
import { createMemoryWorkspaceStore } from "./memory.ts"

import type {
  CloudflareArtifactsWorkspaceStoreOptions,
  GitHubWorkspaceOption,
  GitHubWorkspaceStoreOptions,
  VercelBlobWorkspaceStoreOptions,
  WorkspaceDefinition,
  WorkspaceStore,
  WorkspaceStoreOptions,
} from "../core/types.ts"

export interface WorkspaceResolutionInput {
  dev?: boolean
  env?: Record<string, string | undefined>
  hosting?: string
  rootDir?: string
  runtime?: boolean
}

export const MASKED_WORKSPACE_RUNTIME_VALUE = "********"
export type ResolvedWorkspaceStoreOptions = Exclude<WorkspaceStoreOptions, WorkspaceStore>

function workspaceRepoName(name: string | undefined) {
  return name ? name.replace(/[^a-zA-Z0-9_.-]/g, "-") : undefined
}

function gitHubWorkspaceOption(value: GitHubWorkspaceOption | undefined): GitHubWorkspaceOption | undefined {
  return typeof value === "function" ? value : trimmed(value)
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
    token: MASKED_WORKSPACE_RUNTIME_VALUE,
  }
}

export function resolveGitHubWorkspaceStore(
  config: Partial<GitHubWorkspaceStoreOptions> = {},
  env: Record<string, string | undefined> = process.env,
  input: Pick<WorkspaceResolutionInput, "runtime"> = {},
): GitHubWorkspaceStoreOptions {
  if (input.runtime) {
    return {
      branch: gitHubWorkspaceOption(config.branch)
        ?? readEnv(env, "WORKSPACE_GITHUB_BRANCH", "VITEHUB_WORKSPACE_GITHUB_BRANCH", "GITHUB_BRANCH"),
      provider: "github",
      repository: gitHubWorkspaceOption(config.repository)
        ?? gitHubWorkspaceOption(config.repo)
        ?? readEnv(env, "WORKSPACE_GITHUB_REPOSITORY", "VITEHUB_WORKSPACE_GITHUB_REPOSITORY", "GITHUB_REPOSITORY"),
      root: gitHubWorkspaceOption(config.root)
        ?? readEnv(env, "WORKSPACE_GITHUB_ROOT", "VITEHUB_WORKSPACE_GITHUB_ROOT"),
      token: gitHubWorkspaceOption(config.token)
        ?? readEnv(env, "WORKSPACE_GITHUB_TOKEN", "VITEHUB_WORKSPACE_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN")
        ?? MASKED_WORKSPACE_RUNTIME_VALUE,
    }
  }
  return {
    branch: gitHubWorkspaceOption(config.branch) ?? readEnv(env, "WORKSPACE_GITHUB_BRANCH", "VITEHUB_WORKSPACE_GITHUB_BRANCH", "GITHUB_BRANCH") ?? "main",
    provider: "github",
    repository: gitHubWorkspaceOption(config.repository)
      ?? gitHubWorkspaceOption(config.repo)
      ?? readEnv(env, "WORKSPACE_GITHUB_REPOSITORY", "VITEHUB_WORKSPACE_GITHUB_REPOSITORY", "GITHUB_REPOSITORY"),
    root: gitHubWorkspaceOption(config.root) ?? readEnv(env, "WORKSPACE_GITHUB_ROOT", "VITEHUB_WORKSPACE_GITHUB_ROOT") ?? ".vitehub/workspaces/<workspace>",
    token: MASKED_WORKSPACE_RUNTIME_VALUE,
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

  if (input.dev && !store) return { provider: "local" as const }

  const env = input.env || process.env
  const hosting = input.hosting || ""

  if (store?.provider === "cloudflare-artifacts") return resolveCloudflareArtifactsStore(store, env)
  if (store?.provider === "github") return resolveGitHubWorkspaceStore(store, env, input)
  if (store?.provider === "memory") return store
  if (store?.provider === "vercel-blob") return resolveVercelBlobWorkspaceStore(store, env)
  if (store?.provider === "local" || store?.root) return defu(store, { provider: "local" as const }) as ResolvedWorkspaceStoreOptions
  if (store && "provider" in store) throw workspaceError(`[vitehub] Unsupported workspace store provider: ${String(store.provider)}.`)

  if (hosting.includes("cloudflare")) return { provider: "memory" as const }
  if (hasVercelWorkspaceBlobEnv(env)) return resolveVercelBlobWorkspaceStore({}, env)
  if (hosting.includes("vercel")) return { provider: "memory" as const }

  return { provider: "local" as const }
}

export function createWorkspaceStoreFromProvider(definition: WorkspaceDefinition): WorkspaceStore {
  if (definition.store && "readFile" in definition.store) return definition.store

  const rootDir = definition.rootDir || process.cwd()
  const runtimeConfig = getWorkspaceRuntimeConfig()
  const runtimeStore = runtimeConfig ? runtimeConfig.store : undefined
  const store = normalizeWorkspaceStoreOptions(definition.store || runtimeStore, {
    env: typeof process !== "undefined" ? process.env : {},
    hosting: typeof process !== "undefined" ? process.env.VITEHUB_HOSTING : undefined,
    rootDir,
    runtime: true,
  })

  if (store?.provider === "memory") return createMemoryWorkspaceStore()
  if (store?.provider === "cloudflare-artifacts" || store?.provider === "github" || store?.provider === "vercel-blob") {
    const loader = getWorkspaceHostedStoreLoader()
    if (!loader && store.provider === "github") return createGitHubWorkspaceStore(store, definition.name)
    if (!loader) throw workspaceError(`[vitehub] Hosted workspace store "${store.provider}" is not available in this runtime.`)
    return loader(store, definition.name)
  }

  const root = store?.root
    ? resolve(rootDir, store.root)
    : runtimeConfig
      ? resolve(runtimeConfig.root, definition.name)
      : resolve(rootDir, ".vitehub/workspaces", definition.name)
  return createLocalWorkspaceStore(root)
}

export function isMaskedWorkspaceRuntimeValue(value: string | undefined): boolean {
  return !value || value === MASKED_WORKSPACE_RUNTIME_VALUE
}

export function resolveRuntimeVercelBlobWorkspaceStore(
  config: VercelBlobWorkspaceStoreOptions,
  env: Record<string, string | undefined>,
): VercelBlobWorkspaceStoreOptions {
  const token = readEnv(env, "BLOB_READ_WRITE_TOKEN")

  if (isMaskedWorkspaceRuntimeValue(token)) {
    throw new Error("Missing runtime environment variable `BLOB_READ_WRITE_TOKEN` for Vercel workspace Blob storage.")
  }

  return {
    ...config,
    token,
  }
}
