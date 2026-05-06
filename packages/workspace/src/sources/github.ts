import { getActiveCloudflareBinding } from "@vitehub/internal/runtime/cloudflare-env"
import { github as createGitHubSource, type GitHubSourceOptions as UnsourceGitHubSourceOptions } from "@vitehub/unsource"

import { resolveWorkspaceEnv } from "../env.ts"
import type { SourceContext, WorkspaceSource } from "../types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "swr" | "validate">
type GitHubAuth = NonNullable<UnsourceGitHubSourceOptions["auth"]>

export interface GitHubSourceOptions extends Omit<UnsourceGitHubSourceOptions, "auth">, SourceRuntimeOptions {
  auth?: GitHubAuth
}

export function github(options: GitHubSourceOptions): WorkspaceSource {
  const baseSource = createGitHubSource({
    ...options,
    auth: createGitHubAuthResolver(options.auth),
  })
  const sourceByRoot = new Map<string, typeof baseSource>()

  async function getSourceForRoot(rootDir: string) {
    const cachedSource = sourceByRoot.get(rootDir)
    if (cachedSource) return cachedSource
    const envFileToken = await resolveWorkspaceEnv(rootDir, "GITHUB_TOKEN")
    const source = createGitHubSource({
      ...options,
      auth: createGitHubAuthResolver(options.auth, envFileToken),
    })
    sourceByRoot.set(rootDir, source)
    return source
  }

  return {
    ...baseSource,
    cache: options.cache,
    materialize: options.materialize,
    mount: options.mount,
    swr: options.swr,
    validate: options.validate,
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
