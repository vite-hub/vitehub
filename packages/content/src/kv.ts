/** The part of a ViteHub KV store that Content uses, such as `kv` from `@vite-hub/kv`. */
export interface ContentKV {
  get<T>(key: string): Promise<readonly [unknown, T | null | undefined]>
  set<T>(key: string, value: T, options?: { ttl?: number }): Promise<readonly [unknown, unknown]>
}

let installedKV: ContentKV | undefined
/**
 * The build that registered KV. Plugin options can live in closures that the parser hash cannot read, so each build
 * gets its own commit cache keys.
 */
let installedBuild: string | undefined

/**
 * Give Content the KV store that keeps the heads of `github()` Sources and the GitHub answers of a GitHub Workspace
 * store. When the app enables ViteHub KV, the build calls it at the top of `server/content.ts`; you do not call it
 * yourself. Without it, no Source is live, and each server instance reads the repository again after it starts.
 */
export function registerContentKV(store: ContentKV | undefined, build?: string): void {
  installedKV = store
  installedBuild = build
}

export function contentKV(): ContentKV | undefined {
  return installedKV
}

export function contentKVBuild(): string | undefined {
  return installedBuild
}
