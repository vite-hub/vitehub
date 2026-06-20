import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"
import { github as createGitHubSource, type GitHubSourceOptions as SourcePackageGitHubSourceOptions } from "@vite-hub/source"

import { resolveWorkspaceEnv } from "../env.ts"
import type { MaybePromise, WorkspaceSource, WorkspaceSourceResolutionContext } from "../core/types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "instructions" | "materialize" | "mount" | "sync" | "validate">
type GitHubAuth = NonNullable<SourcePackageGitHubSourceOptions["auth"]>

export interface GitHubSourceOptions extends Omit<SourcePackageGitHubSourceOptions, "auth">, SourceRuntimeOptions {
  auth?: GitHubAuth
}

export type GitHubSourceResolver = (
  context: WorkspaceSourceResolutionContext,
) => MaybePromise<GitHubSourceOptions | false | null | undefined>

export type GitHubSourceInput = GitHubSourceOptions | GitHubSourceResolver

export function github(options: GitHubSourceOptions): WorkspaceSource
export function github(resolve: GitHubSourceResolver): WorkspaceSource
export function github(input: GitHubSourceInput): WorkspaceSource {
  if (typeof input === "function") return resolvableGitHubSource(input)

  const options = input
  const resolvedOptions = {
    ...options,
    mount: options.mount ?? inferRepositoryMount(options.repo),
  }
  const baseSource = createGitHubSource({
    ...resolvedOptions,
    auth: createGitHubAuthResolver(resolvedOptions.auth),
  })
  const sourceByRootAndToken = new Map<string, typeof baseSource>()

  async function getSourceForRoot(rootDir: string) {
    const envFileToken = await resolveWorkspaceEnv(rootDir, "GITHUB_TOKEN")
    const cacheKey = `${rootDir}\0${envFileToken ?? ""}`
    const cachedSource = sourceByRootAndToken.get(cacheKey)
    if (cachedSource) return cachedSource
    const source = createGitHubSource({
      ...resolvedOptions,
      auth: createGitHubAuthResolver(resolvedOptions.auth, envFileToken),
    })
    sourceByRootAndToken.set(cacheKey, source)
    return source
  }

  return {
    ...baseSource,
    cache: resolvedOptions.cache,
    fingerprint: {
      exclude: resolvedOptions.exclude,
      include: resolvedOptions.include,
      ref: resolvedOptions.ref,
      repo: resolvedOptions.repo,
      root: resolvedOptions.root,
    },
    instructions: resolvedOptions.instructions,
    materialize: resolvedOptions.materialize,
    mount: resolvedOptions.mount,
    sync: resolvedOptions.sync,
    validate: resolvedOptions.validate,
    async prepare(ctx) {
      const source = await getSourceForRoot(ctx.rootDir)
      await source.prepare?.(ctx)
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
    async search(query, ctx) {
      const source = await getSourceForRoot(ctx.rootDir)
      return await source.search?.(query, ctx) ?? []
    },
  }
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
    async search() {
      return []
    },
    async resolve(ctx) {
      const options = await resolve(ctx)
      return options ? github(options) : false
    },
  }
}

function inferRepositoryMount(repo: string | undefined) {
  return repo?.split("/").filter(Boolean).at(-1)
}

function createGitHubAuthResolver(auth: GitHubAuth | undefined, envFileToken?: string) {
  return () => {
    return resolveGitHubAuth(auth)
      || getActiveCloudflareBinding<string>("GITHUB_TOKEN")
      || process.env.GITHUB_TOKEN
      || envFileToken
  }
}

function resolveGitHubAuth(auth: GitHubAuth | undefined): string | undefined {
  return typeof auth === "function" ? auth() : auth
}
