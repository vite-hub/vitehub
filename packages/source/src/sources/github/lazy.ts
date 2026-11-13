import { normalizeGitHubRoot } from "./root.ts"

import type { GitHubSource, GitHubSourceOptions } from "./types.ts"

/**
 * github() as the Source root exports it. The loader imports Node built-ins, ocache, and the forge client, so it loads
 * on the first read. A bundle that imports the root and never calls github() keeps none of them.
 */
export function github(options: GitHubSourceOptions): GitHubSource {
  const root = normalizeGitHubRoot(options.root || "")
  let loader: Promise<GitHubSource> | undefined
  // A failed load lets the next read try again.
  const load = () => loader ??= import("./index.ts").then(module => module.github(options)).catch((error: unknown) => {
    loader = undefined
    throw error
  })
  return {
    cache: options.cache,
    fingerprint: {
      ignore: options.ignore,
      include: options.include,
      ref: options.ref || "default",
      repo: options.repo,
      root,
    },
    name: "github",
    authenticated: async () => await (await load()).authenticated(),
    history: async (key, historyOptions) => await (await load()).history(key, historyOptions),
    latest: async (keys, latestOptions) => await (await load()).latest(keys, latestOptions),
    changes: async (base, head) => await (await load()).changes(base, head),
    pullChanges: async number => await (await load()).pullChanges(number),
    resolveRef: async (ref, refOptions) => await (await load()).resolveRef(ref, refOptions),
    contains: async (sha, refOptions) => await (await load()).contains(sha, refOptions),
    pullsAt: async (sha, refOptions) => await (await load()).pullsAt(sha, refOptions),
    resolveRevision: async ctx => await (await load()).resolveRevision(ctx),
    getKeys: async ctx => await (await load()).getKeys(ctx),
    getItems: async ctx => await (await load()).getItems(ctx),
    getMeta: async (key, ctx) => await (await load()).getMeta(key, ctx),
    getItem: async (key, ctx) => await (await load()).getItem(key, ctx),
  }
}
