import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

export const repoRoot = resolve(import.meta.dirname, "../..")
export const packageNames = ["kv", "blob", "queue", "sandbox"] as const

export type PackageName = (typeof packageNames)[number]

type PackageManifest = {
  name?: string
  description?: string
  license?: string
  sideEffects?: boolean
  type?: string
  types?: string
  exports?: Record<string, string | Record<string, string>>
  files?: string[]
  scripts?: Record<string, string>
}

export function packageDir(packageName: PackageName) {
  return join(repoRoot, "packages", packageName)
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

export function readPackageManifest(packageName: PackageName) {
  return readJson<PackageManifest>(join(packageDir(packageName), "package.json"))
}

export function toRepoPath(path: string) {
  return relative(repoRoot, path).replace(/\\/g, "/")
}

export function walkFiles(dir: string, options: { ignoreDirs?: Set<string>, extensions?: Set<string> } = {}) {
  const files: string[] = []
  const ignoreDirs = options.ignoreDirs ?? new Set<string>()

  function walk(currentDir: string) {
    for (const entry of readdirSync(currentDir)) {
      if (ignoreDirs.has(entry)) {
        continue
      }

      const path = join(currentDir, entry)
      const stat = statSync(path)

      if (stat.isDirectory()) {
        walk(path)
        continue
      }

      if (!options.extensions || options.extensions.has(entry.split(".").pop() || "")) {
        files.push(path)
      }
    }
  }

  if (existsSync(dir)) {
    walk(dir)
  }

  return files
}
