import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { array, boolean, type GenericSchema, type InferOutput, object, optional, parse, record, string, union } from "valibot"

import { listWorkspacePackageInfos } from "../../packages/internal/src/workspace-inventory.ts"

export const repoRoot = resolve(import.meta.dirname, "../..")
export const packageInfos = listWorkspacePackageInfos(repoRoot).filter(info => !info.private)
export const packageNames = packageInfos.map(info => info.name)

export type PackageName = string

const stringRecord = record(string(), string())

export const packageManifestSchema = object({
  name: string(),
  bin: optional(stringRecord),
  description: optional(string()),
  license: optional(string()),
  sideEffects: optional(union([boolean(), array(string())])),
  type: optional(string()),
  types: optional(string()),
  exports: optional(record(string(), union([string(), stringRecord]))),
  files: optional(array(string())),
  dependencies: optional(stringRecord),
  devDependencies: optional(stringRecord),
  optionalDependencies: optional(stringRecord),
  peerDependencies: optional(stringRecord),
  peerDependenciesMeta: optional(record(string(), object({ optional: optional(boolean()) }))),
  repository: optional(object({
    directory: optional(string()),
    type: optional(string()),
    url: optional(string()),
  })),
  scripts: optional(stringRecord),
})

export function packageDir(packageName: PackageName) {
  return join(repoRoot, "packages", packageName)
}

export function readJson<TSchema extends GenericSchema>(schema: TSchema, path: string): InferOutput<TSchema> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  return parse(schema, value)
}

export function readPackageManifest(packageName: PackageName) {
  return readJson(packageManifestSchema, join(packageDir(packageName), "package.json"))
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
