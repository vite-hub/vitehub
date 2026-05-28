import { getActiveCloudflareBinding } from "@vitehub/internal/runtime/cloudflare-env"
import { github as createGitHubSource, type GitHubSourceOptions as SourcePackageGitHubSourceOptions } from "@vitehub/source"

import { resolveWorkspaceEnv } from "../env.ts"
import type { WorkspaceSource } from "../core/types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "validate">
type GitHubAuth = NonNullable<SourcePackageGitHubSourceOptions["auth"]>

export interface GitHubSourceOptions extends Omit<SourcePackageGitHubSourceOptions, "auth">, SourceRuntimeOptions {
  auth?: GitHubAuth
}

export function github(options: GitHubSourceOptions): WorkspaceSource {
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
    materialize: resolvedOptions.materialize,
    mount: resolvedOptions.mount,
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
