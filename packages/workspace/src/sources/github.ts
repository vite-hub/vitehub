import { getActiveCloudflareBinding } from "@vitehub/internal/runtime/cloudflare-env"
import { github as createGitHubSource, type GitHubSourceOptions as UnsourceGitHubSourceOptions } from "@vitehub/unsource"

import type { SourceContext, WorkspaceSource } from "../types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "swr" | "validate">
type GitHubAuth = NonNullable<UnsourceGitHubSourceOptions["auth"]>

export interface GitHubSourceOptions extends Omit<UnsourceGitHubSourceOptions, "auth">, SourceRuntimeOptions {
  auth?: GitHubAuth
}

export function github(options: GitHubSourceOptions): WorkspaceSource {
  let envFileToken: string | undefined
  async function prepareEnvFileToken(ctx: SourceContext) {
    envFileToken = await prepareGitHubEnvFileToken(ctx.rootDir)
  }

  const source = createGitHubSource({
    ...options,
    auth: createGitHubAuthResolver(options.auth, () => envFileToken),
  })

  return {
    ...source,
    cache: options.cache,
    materialize: options.materialize,
    mount: options.mount,
    swr: options.swr,
    validate: options.validate,
    async prepare(ctx) {
      await prepareEnvFileToken(ctx)
      await source.prepare?.(ctx)
    },
    async getKeys(ctx) {
      await prepareEnvFileToken(ctx)
      return await source.getKeys(ctx)
    },
    async getItem(key, ctx) {
      await prepareEnvFileToken(ctx)
      return await source.getItem(key, ctx)
    },
    async getMeta(key, ctx) {
      await prepareEnvFileToken(ctx)
      return await source.getMeta?.(key, ctx)
    },
    async search(query, ctx) {
      await prepareEnvFileToken(ctx)
      return await source.search?.(query, ctx) ?? []
    },
  }
}

const envFileTokenByRoot = new Map<string, string | undefined>()
let viteLoadEnv: ((mode: string, root: string, prefix: string) => Record<string, string>) | undefined | null

function createGitHubAuthResolver(auth: GitHubAuth | undefined, getEnvFileToken: () => string | undefined) {
  return () => {
    return resolveGitHubAuth(auth)
      || getActiveCloudflareBinding<string>("GITHUB_TOKEN")
      || process.env.GITHUB_TOKEN
      || getEnvFileToken()
  }
}

function resolveGitHubAuth(auth: GitHubAuth | undefined): string | undefined {
  return typeof auth === "function" ? auth() : auth
}

async function prepareGitHubEnvFileToken(rootDir: string): Promise<string | undefined> {
  if (envFileTokenByRoot.has(rootDir)) return envFileTokenByRoot.get(rootDir)
  const token = (await loadViteEnv(rootDir))?.GITHUB_TOKEN
  envFileTokenByRoot.set(rootDir, token)
  return token
}

async function loadViteEnv(rootDir: string): Promise<Record<string, string> | undefined> {
  if (viteLoadEnv === null) return
  if (!viteLoadEnv) {
    try {
      viteLoadEnv = (await import("vite")).loadEnv
    }
    catch {
      viteLoadEnv = null
      return
    }
  }
  return viteLoadEnv("", rootDir, "")
}
