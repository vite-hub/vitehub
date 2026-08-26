import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { listWorkspacePackageInfos } from "../../packages/internal/src/workspace-inventory.ts"

export const repoRoot = resolve(import.meta.dirname, "../..")
export const packageInfos = listWorkspacePackageInfos(repoRoot).filter(info => !info.private)
export const packageNames = packageInfos.map(info => info.name)

export type PackageName = string

type PackageManifest = {
  name?: string
  description?: string
  license?: string
  sideEffects?: boolean | string[]
  type?: string
  types?: string
  exports?: Record<string, string | Record<string, string>>
  files?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  repository?: { directory?: string, type?: string, url?: string }
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

export function packageInfo(packageName: PackageName) {
  const info = packageInfos.find(entry => entry.name === packageName)
  if (!info) throw new Error(`Unknown publishable workspace package: ${packageName}`)
  return info
}

export function packageInfoByPublishName(publishName: string) {
  const info = packageInfos.find(entry => entry.packageName === publishName)
  if (!info) throw new Error(`Unknown ViteHub package: ${publishName}`)
  return info
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
