import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { subset, validRange } from "semver"

import { codemodError } from "../error-diagnostics.ts"
import { readPnpmCatalogVersion } from "./pnpm-catalog.ts"

import type { FileEdit, FollowUp } from "../types.ts"

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
  followUps: FollowUp[]
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
   * A package that the migrated code needs at `range`. A declared range that allows a version outside it stops the
   * codemod. A declaration the codemod cannot read stays as it is, with a follow-up.
   */
  require?: { name: string, range: string, feature: string }
}

function outside(range: string, supported: string): boolean {
  return validRange(range) !== null && !subset(range, supported, { includePrerelease: true })
}

async function resolveDeclaredRange(cwd: string, name: string, declared: string): Promise<{ range: string, catalog: boolean } | undefined> {
  const catalog = /^catalog:(.*)$/.exec(declared)?.[1]
  const range = catalog === undefined ? declared : await readPnpmCatalogVersion(cwd, name, catalog.trim() || "default")
  if (range === undefined) return
  return { range: range.startsWith(`npm:${name}@`) ? range.slice(`npm:${name}@`.length) : range, catalog: catalog !== undefined }
}

/**
 * Removes `change.remove` and adds `change.add`. Added packages go to the section that held a removed package,
 * or to `dependencies`.
 */
export async function editPackageJson(cwd: string, version: string, change: PackageJsonChange): Promise<PackageJsonResult> {
  const path = join(cwd, "package.json")
  const command = detectInstallCommand(cwd)
  const required = change.require
  if (!existsSync(path)) {
    if (required) throw codemodError(`Create a package.json for this app before migrating to ${required.feature}.`)
    return { installCommand: command, followUps: [] }
  }
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
  const followUps: FollowUp[] = []
  if (required) {
    for (const section of [...sections, "optionalDependencies", "peerDependencies"]) {
      const map = manifest[section]
      if (!isRecord(map) || !(required.name in map)) continue
      const declared = map[required.name]
      const resolved = typeof declared === "string" ? await resolveDeclaredRange(cwd, required.name, declared) : undefined
      const needs = `${required.feature} needs ${required.name} ${required.range}`
      if (resolved === undefined || validRange(resolved.range) === null) {
        const source = resolved?.catalog ? `, which pnpm-workspace.yaml sets to ${JSON.stringify(resolved.range)}` : ""
        followUps.push({ file: "package.json", message: `package.json ${section} declares ${required.name} ${JSON.stringify(declared)}${source}. The codemod cannot read it as a version range, so it kept it. ${needs}. Check that it installs such a version.` })
        continue
      }
      if (outside(resolved.range, required.range)) {
        const source = resolved.catalog ? ` (pnpm-workspace.yaml sets ${JSON.stringify(declared)} to ${JSON.stringify(resolved.range)})` : ""
        throw codemodError(`Migration to ${needs}. Update its range in package.json ${section}${source}, then run the codemod again.`)
      }
    }
    if (!installed(required.name)) dependencies[required.name] = required.range
  }
  for (const name of change.add) if (!installed(name)) dependencies[name] = range
  for (const [name, supported] of Object.entries(change.within ?? {})) {
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
  return { edit: after === before ? undefined : { path: "package.json", before, after }, installCommand: command, followUps }
}
