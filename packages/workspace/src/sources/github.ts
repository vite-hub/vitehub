import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"
import { sourceIgnores } from "@vite-hub/source"
import { github as createGitHubSource, type GitHubSourceOptions as SourcePackageGitHubSourceOptions } from "@vite-hub/source/github"

import { prepareWorkspaceSource } from "./preparation.ts"
import { withWorkspaceRuntimeOptions } from "./runtime-options.ts"
import { resolveWorkspaceEnv } from "../env.ts"
import { processEnv, resolveGitHubTokenOption } from "../providers/github/shared.ts"
import type { ExactOptions, WorkspaceSourceRuntimeOptions } from "./runtime-options.ts"
import type { MaybePromise, WorkspaceSource, WorkspaceSourceResolutionContext } from "../core/types.ts"

type GitHubAuth = NonNullable<SourcePackageGitHubSourceOptions["auth"]>
type GitHubResolvedSourceOptions = Omit<GitHubSourceOptions, "repo"> & Partial<Pick<GitHubSourceOptions, "repo">>
const githubTokenEnvNames = ["WORKSPACE_GITHUB_TOKEN", "VITEHUB_WORKSPACE_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] as const

export interface GitHubSourceOptions extends Omit<SourcePackageGitHubSourceOptions, "auth" | "ignore">, WorkspaceSourceRuntimeOptions {
  auth?: GitHubAuth
  /** Adds to the default Source ignores. Set to false to include every matched path. */
  ignore?: false | string | readonly string[]
}

export type GitHubSourceResolver = (
  context: WorkspaceSourceResolutionContext,
) => MaybePromise<GitHubResolvedSourceOptions | false | null | undefined>

export type GitHubSourceInput = GitHubSourceOptions | GitHubSourceResolver

export function github<const TOptions extends GitHubSourceOptions>(options: ExactOptions<TOptions, GitHubSourceOptions>): WorkspaceSource
export function github(resolve: GitHubSourceResolver): WorkspaceSource
export function github(input: GitHubSourceInput): WorkspaceSource {
  if (typeof input === "function") return resolvableGitHubSource(input)

  const options = input
  const resolvedOptions = {
    ...options,
    ignore: resolveGitHubIgnore(options.ignore),
  }
  const baseSource = createGitHubSource({
    ...resolvedOptions,
    auth: createGitHubAuthResolver(resolvedOptions.auth),
  })
  const sourceByRootAndToken = new Map<string, typeof baseSource>()

  async function getSourceForRoot(rootDir: string) {
    const token = await resolveGitHubAuth(resolvedOptions.auth, rootDir)
    const cacheKey = `${rootDir}\0${token || ""}`
    const cachedSource = sourceByRootAndToken.get(cacheKey)
    if (cachedSource) return cachedSource
    const source = createGitHubSource({
      ...resolvedOptions,
      auth: token,
    })
    sourceByRootAndToken.set(cacheKey, source)
    return source
  }

  return withWorkspaceRuntimeOptions({
    ...baseSource,
    fingerprint: {
      ignore: resolvedOptions.ignore,
      include: resolvedOptions.include,
      ref: resolvedOptions.ref,
      repo: resolvedOptions.repo,
      root: resolvedOptions.root,
    },
    async resolveRevision(ctx) {
      const source = await getSourceForRoot(ctx.rootDir)
      return await source.resolveRevision?.(ctx)
    },
    async prepare(ctx) {
      const source = await getSourceForRoot(ctx.rootDir)
      await prepareWorkspaceSource(source, ctx)
    },
    async getKeys(ctx) {
      const source = await getSourceForRoot(ctx.rootDir)
      return await source.getKeys(ctx)
    },
    async getItem(key, ctx) {
      const source = await getSourceForRoot(ctx.rootDir)
      return await source.getItem(key, ctx)
    },
    async getItems(ctx) {
      const source = await getSourceForRoot(ctx.rootDir)
      return await source.getItems?.(ctx) ?? await Promise.all((await source.getKeys(ctx)).map(key => source.getItem(key, ctx)))
    },
    async getMeta(key, ctx) {
      const source = await getSourceForRoot(ctx.rootDir)
      return await source.getMeta?.(key, ctx)
    },
  }, resolvedOptions)
}

function resolveGitHubIgnore(ignore: GitHubSourceOptions["ignore"]): string[] | undefined {
  if (ignore === false) return
  return [
    ...sourceIgnores.defaults,
    ...(typeof ignore === "string" ? [ignore] : ignore || []),
  ]
}

function resolvableGitHubSource(resolve: GitHubSourceResolver): WorkspaceSource {
  return {
    fingerprint: {
      sourceResolution: "github",
    },
    materialize: "lazy",
    async getKeys() {
      return []
    },
    async getItem(key) {
      throw new Error(`[vitehub] github() resolver did not resolve before reading ${JSON.stringify(key)}.`)
    },
    async getItems() {
      return []
    },
    async resolve(ctx) {
      const options = await resolve(ctx)
      return options ? github(githubResolutionDefaults(options, ctx)) : false
    },
  }
}

function githubResolutionDefaults(options: GitHubResolvedSourceOptions, ctx: WorkspaceSourceResolutionContext): GitHubSourceOptions {
  const source = pullRequestSource(ctx.invocation.context.get("pullRequest"))
  const repo = options.repo || source?.repo
  if (!repo) throw new Error("[vitehub] github() resolver requires repo or typed pullRequest source context.")
  return {
    ...options,
    mount: options.mount ?? ctx.source.mountPath,
    ref: options.ref ?? source?.ref,
    repo,
  }
}

function pullRequestSource(value: unknown): { ref?: string, repo?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const flatRef = (value as { headRef?: unknown }).headRef
  const directSource = (value as { source?: unknown }).source
  if (directSource && typeof directSource === "object" && !Array.isArray(directSource)) {
    const ref = (directSource as { ref?: unknown }).ref
    const repo = (directSource as { repo?: unknown }).repo
    if (typeof repo === "string" && repo) {
      const resolvedRef = typeof ref === "string" && ref ? ref : typeof flatRef === "string" && flatRef ? flatRef : undefined
      return { ...(resolvedRef ? { ref: resolvedRef } : {}), repo }
    }
  }
  const flatRepo = (value as { repository?: unknown }).repository
  if (typeof flatRepo === "string" && flatRepo) {
    return {
      ...(typeof flatRef === "string" && flatRef ? { ref: flatRef } : {}),
      repo: flatRepo,
    }
  }
  const pullRequest = (value as { pullRequest?: unknown }).pullRequest
  if (!pullRequest || typeof pullRequest !== "object" || Array.isArray(pullRequest)) return
  const source = (pullRequest as { source?: unknown }).source
  if (!source || typeof source !== "object" || Array.isArray(source)) return
  const ref = (source as { ref?: unknown }).ref
  const repo = (source as { repo?: unknown }).repo
  return {
    ...(typeof ref === "string" && ref ? { ref } : {}),
    ...(typeof repo === "string" && repo ? { repo } : {}),
  }
}

function createGitHubAuthResolver(auth: GitHubAuth | undefined) {
  if (auth === false) return false
  return () => {
    return resolveExplicitGitHubAuth(auth)
      || getActiveCloudflareBinding<string>("GITHUB_TOKEN")
      || processEnv(process.env, ...githubTokenEnvNames)
  }
}

async function resolveGitHubAuth(auth: GitHubAuth | undefined, rootDir: string): Promise<GitHubAuth | undefined> {
  if (auth === false) return false
  return resolveExplicitGitHubAuth(auth)
    || resolveGitHubTokenOption({})
    || await resolveGitHubEnvFileToken(rootDir)
    || await resolveGitHubCliToken()
}

function resolveExplicitGitHubAuth(auth: GitHubAuth | undefined): string | undefined {
  if (auth === false) return undefined
  if (typeof auth === "function") return auth()
  return typeof auth === "string" ? auth : undefined
}

async function resolveGitHubEnvFileToken(rootDir: string): Promise<string | undefined> {
  const env = Object.fromEntries(await Promise.all(githubTokenEnvNames.map(async name => [name, await resolveWorkspaceEnv(rootDir, name)] as const)))
  return processEnv(env, ...githubTokenEnvNames)
}

async function resolveGitHubCliToken(): Promise<string | undefined> {
  try {
    const { execFileSync } = await import("node:child_process")
    return execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim() || undefined
  }
  catch {
    return
  }
}
