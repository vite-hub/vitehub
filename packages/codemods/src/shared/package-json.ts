import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { features, installSpecifier } from "@vite-hub/internal/features"
import { invariant } from "@vite-hub/internal/invariant"
import { subset, validRange } from "semver"

import { codemodError } from "../error-diagnostics.ts"

import type { FeatureId } from "@vite-hub/internal/features"
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
  /** The ViteHub packages that the codemod adds, as a list for the report, such as "vite-hub and @vite-hub/email". */
  installs: string
}

function detectInstallCommand(cwd: string): string {
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

export interface PackageJsonChange {
  /** Packages to remove from `dependencies` and `devDependencies`. */
  remove: readonly string[]
  /** Packages to add at `^version` when no section lists them. */
  add: readonly string[]
  /**
   * Packages to add at a range, or to move into it, by name. A listed range that allows a version outside it becomes
   * that range. A range the codemod cannot read stays as it is.
   */
  within?: Readonly<Record<string, string>>
  /**
   * Features that the migrated app turns on. `vite-hub` resolves the packages of each one from the app, and the build
   * stops while one is missing, so each package is added: a `@vite-hub/*` package like `add`, and another package at
   * the range of `within` or of `vitehub add`.
   */
  features?: readonly FeatureId[]
}

function withFeaturePackages(change: PackageJsonChange): { add: string[], within: Record<string, string> } {
  const packages = [...new Set((change.features ?? []).flatMap(id => features[id].packages))]
  const own = packages.filter(name => name.startsWith("@vite-hub/"))
  const within = { ...change.within }
  for (const name of packages.filter(name => !own.includes(name))) {
    const range = within[name] ?? installSpecifier(name).slice(name.length + 1)
    invariant(range, `every codemod that turns on a feature passes a range for its package ${name}`)
    within[name] = range
  }
  return { add: [...new Set([...change.add, ...own])], within }
}

/** True when `range` allows a version that `supported` does not. A prerelease in `range` counts. */
function outside(range: string, supported: string): boolean {
  return validRange(range) !== null && !subset(range, supported, { includePrerelease: true })
}

/**
 * Removes `change.remove` and adds `change.add`. Added packages go to the section that held a removed package,
 * or to `dependencies`.
 */
export async function editPackageJson(cwd: string, version: string, change: PackageJsonChange): Promise<PackageJsonResult> {
  const path = join(cwd, "package.json")
  const command = detectInstallCommand(cwd)
  const { add, within } = withFeaturePackages(change)
  const installs = new Intl.ListFormat("en", { type: "conjunction" }).format(add)
  if (!existsSync(path)) return { installCommand: command, installs }
  const before = await readFile(path, "utf8")
  let manifest: unknown
  try {
    manifest = JSON.parse(before)
  }
  catch (error) {
    throw codemodError(`Cannot parse package.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(manifest)) throw codemodError("package.json must contain an object.")
  const range = `^${version}`
  let target: (typeof sections)[number] = "dependencies"
  for (const section of sections) {
    const dependencies = manifest[section]
    if (dependencies !== undefined && !isDependencyMap(dependencies)) throw codemodError(`package.json ${section} must map names to version strings.`)
    if (dependencies && change.remove.some(name => name in dependencies)) {
      target = section
      manifest[section] = Object.fromEntries(Object.entries(dependencies).filter(([name]) => !change.remove.includes(name)))
    }
  }
  const current = manifest[target]
  const dependencies: DependencyMap = isDependencyMap(current) ? { ...current } : {}
  const installed = (name: string) => sections.some((section) => {
    const map = manifest[section]
    return isDependencyMap(map) && name in map
  })
  for (const name of add) if (!installed(name)) dependencies[name] = range
  for (const [name, supported] of Object.entries(within)) {
    if (!installed(name)) {
      dependencies[name] = supported
      continue
    }
    for (const section of sections) {
      const map = section === target ? dependencies : manifest[section]
      if (isDependencyMap(map) && typeof map[name] === "string" && outside(map[name], supported)) map[name] = supported
    }
  }
  manifest[target] = Object.fromEntries(Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)))
  const indent = /^[ \t]+/m.exec(before)?.[0] ?? "  "
  const after = `${JSON.stringify(manifest, null, indent)}${before.endsWith("\n") ? "\n" : ""}`
  return { edit: after === before ? undefined : { path: "package.json", before, after }, installCommand: command, installs }
}
