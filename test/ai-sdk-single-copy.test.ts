import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"
import { parseAllDocuments } from "yaml"

const repoRoot = resolve(import.meta.dirname, "..")

type LockDependency = { version: string } | string
type LockEntry = {
  dependencies?: Record<string, LockDependency>
  optionalDependencies?: Record<string, LockDependency>
}
type Lockfile = {
  importers: Record<string, LockEntry>
  snapshots: Record<string, LockEntry>
}
type Catalogs = { catalogs: Record<string, Record<string, string>> }
type Manifest = { dependencies?: Record<string, string>, optionalDependencies?: Record<string, string> }

async function readLockfile(): Promise<Lockfile> {
  return parseAllDocuments(await readFile(resolve(repoRoot, "pnpm-lock.yaml"), "utf8")).at(-1)?.toJS()
}

function productionDependencies(entry: LockEntry | undefined): [string, string][] {
  return Object.entries({ ...entry?.dependencies, ...entry?.optionalDependencies })
    .map(([name, dependency]) => [name, typeof dependency === "string" ? dependency : dependency.version])
}

function installedVersions(lockfile: Lockfile, importer: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>()
  const seen = new Set<string>()
  const visit = (from: string, entry: LockEntry | undefined) => {
    for (const [name, version] of productionDependencies(entry)) {
      if (version.startsWith("link:")) {
        const workspaceImporter = resolve(repoRoot, from, version.slice("link:".length)).slice(repoRoot.length + 1)
        if (seen.has(workspaceImporter)) continue
        seen.add(workspaceImporter)
        visit(workspaceImporter, lockfile.importers[workspaceImporter])
        continue
      }
      const key = `${name}@${version}`
      if (seen.has(key)) continue
      seen.add(key)
      versions.set(name, (versions.get(name) ?? new Set()).add(version.replace(/\(.*$/, "")))
      visit(from, lockfile.snapshots[key])
    }
  }
  visit(importer, lockfile.importers[importer])
  return versions
}

describe("AI SDK packages", () => {
  it("installs one version of each AI SDK package with @vite-hub/agent", async () => {
    const lockfile = await readLockfile()
    const versions = installedVersions(lockfile, "packages/agent")
    expect(versions.has("ai")).toBe(true)
    const duplicates = [...versions].filter(([name, set]) => name.startsWith("@ai-sdk/") && set.size > 1)
      .map(([name, set]) => `${name}: ${[...set].sort().join(", ")}`)
    expect(duplicates).toEqual([])
  })

  it("pins the AI SDK packages of @vite-hub/agent to the versions that its AI SDK dependencies pin", async () => {
    const lockfile = await readLockfile()
    const { catalogs }: Catalogs = parseAllDocuments(await readFile(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8")).at(-1)?.toJS()
    const manifest: Manifest = JSON.parse(await readFile(resolve(repoRoot, "packages/agent/package.json"), "utf8"))
    const ranges = new Map(Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })
      .filter(([name]) => name === "ai" || name.startsWith("@ai-sdk/"))
      .map(([name, specifier]) => [name, specifier.startsWith("catalog:") ? catalogs[specifier.slice("catalog:".length)]![name]! : specifier]))
    const installed = new Map(productionDependencies(lockfile.importers["packages/agent"]))
    const mismatches = [...ranges.keys()].flatMap(name => productionDependencies(lockfile.snapshots[`${name}@${installed.get(name)}`])
      .filter(([dependency, version]) => ranges.has(dependency) && ranges.get(dependency) !== version.replace(/\(.*$/, ""))
      .map(([dependency, version]) => `${dependency}: @vite-hub/agent asks ${ranges.get(dependency)}, ${name} pins ${version}`))
    expect(mismatches).toEqual([])
  })
})
