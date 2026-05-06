import { getActiveCloudflareBinding } from "@vitehub/internal/runtime/cloudflare-env"
import { github as createGitHubSource, type GitHubSourceOptions as UnsourceGitHubSourceOptions } from "@vitehub/unsource"

import type { WorkspaceSource } from "../types.ts"

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "mount" | "swr" | "validate">

export interface GitHubSourceOptions extends Omit<UnsourceGitHubSourceOptions, "auth">, SourceRuntimeOptions {
  auth?: string
}

export function github(options: GitHubSourceOptions): WorkspaceSource {
  const source = createGitHubSource({
    ...options,
    auth: () => options.auth || getActiveCloudflareBinding<string>("GITHUB_TOKEN") || process.env.GITHUB_TOKEN,
  })

  return {
    ...source,
    cache: options.cache,
    materialize: options.materialize,
    mount: options.mount,
    swr: options.swr,
    validate: options.validate,
  }
}
