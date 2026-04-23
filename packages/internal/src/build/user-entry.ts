import { existsSync } from "node:fs"
import { basename, resolve } from "node:path"

export function toSafeAppName(rootDir: string): string {
  return basename(rootDir).replace(/[^a-z0-9-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase()
}

const DEFAULT_ENTRY_NAMES = [
  "server.ts",
  "server.mts",
  "server.js",
  "server.mjs",
  "worker.ts",
  "worker.mts",
  "worker.js",
  "worker.mjs",
] as const

export interface ResolveUserAppEntryOptions {
  names?: readonly string[]
  srcSubdir?: string
}

export function resolveUserAppEntry(
  rootDir: string,
  options: ResolveUserAppEntryOptions = {},
): string | undefined {
  const names = options.names ?? DEFAULT_ENTRY_NAMES
  const srcSubdir = options.srcSubdir ?? "src"
  return names.map(name => resolve(rootDir, srcSubdir, name)).find(existsSync)
}
