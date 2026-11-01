import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { CodemodError } from "../types.ts"
import { moduleName } from "./nuxt-config.ts"

import type { FileEdit } from "../types.ts"

type Manifest = Record<string, unknown>
type DependencyMap = Record<string, string>

const sections = ["dependencies", "devDependencies"] as const

function isRecord(value: unknown): value is Manifest {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isDependencyMap(value: unknown): value is DependencyMap {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === "string")
}

export interface PackageJsonResult {
  edit?: FileEdit
  installCommand: string
}

function installCommand(cwd: string): string {
  for (let directory = cwd, depth = 0; depth < 8; depth++) {
    if (existsSync(join(directory, "pnpm-lock.yaml"))) return "pnpm install"
    if (existsSync(join(directory, "bun.lock")) || existsSync(join(directory, "bun.lockb"))) return "bun install"
    if (existsSync(join(directory, "yarn.lock"))) return "yarn install"
    if (existsSync(join(directory, "package-lock.json"))) return "npm install"
    const parent = join(directory, "..")
    if (parent === directory) break
    directory = parent
  }
  return "npm install"
}

/** Swaps `nuxt-safe-runtime-config` for `vite-hub`, and adds `@vite-hub/env` when the config imports it. */
export async function editPackageJson(cwd: string, version: string, options: { env: boolean }): Promise<PackageJsonResult> {
  const path = join(cwd, "package.json")
  const command = installCommand(cwd)
  if (!existsSync(path)) return { installCommand: command }
  const before = await readFile(path, "utf8")
  let manifest: unknown
  try {
    manifest = JSON.parse(before)
  }
  catch (error) {
    throw new CodemodError(`Cannot parse package.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(manifest)) throw new CodemodError("package.json must contain an object.")
  const range = `^${version}`
  let target: (typeof sections)[number] = "dependencies"
  for (const section of sections) {
    const dependencies = manifest[section]
    if (dependencies !== undefined && !isDependencyMap(dependencies)) throw new CodemodError(`package.json ${section} must map names to version strings.`)
    if (dependencies && moduleName in dependencies) {
      target = section
      manifest[section] = Object.fromEntries(Object.entries(dependencies).filter(([name]) => name !== moduleName))
    }
  }
  const current = manifest[target]
  const dependencies: DependencyMap = isDependencyMap(current) ? { ...current } : {}
  const installed = (name: string) => sections.some((section) => {
    const map = manifest[section]
    return isDependencyMap(map) && name in map
  })
  if (!installed("vite-hub")) dependencies["vite-hub"] = range
  if (options.env && !installed("@vite-hub/env")) dependencies["@vite-hub/env"] = range
  manifest[target] = Object.fromEntries(Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)))
  const indent = /^[ \t]+/m.exec(before)?.[0] ?? "  "
  const after = `${JSON.stringify(manifest, null, indent)}${before.endsWith("\n") ? "\n" : ""}`
  return { edit: after === before ? undefined : { path: "package.json", before, after }, installCommand: command }
}
