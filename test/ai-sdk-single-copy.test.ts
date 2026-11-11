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

function productionDependencies(entry: LockEntry | undefined): [string, string][] {
  return Object.entries({ ...entry?.dependencies, ...entry?.optionalDependencies })
    .map(([name, dependency]) => [name, typeof dependency === "string" ? dependency : dependency.version])
}

/** Every version of every package that installing `importer` from npm brings in, keyed by package name. */
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
    const lockfile: Lockfile = parseAllDocuments(await readFile(resolve(repoRoot, "pnpm-lock.yaml"), "utf8")).at(-1)?.toJS()
    const versions = installedVersions(lockfile, "packages/agent")
    expect(versions.has("ai")).toBe(true)
    // Two versions of one package are two copies in every Agent server bundle. Import AI SDK internals that `ai`
    // re-exports, such as `createGateway`, from `ai` instead of pinning the package next to it.
    const duplicates = [...versions].filter(([name, set]) => name.startsWith("@ai-sdk/") && set.size > 1)
      .map(([name, set]) => `${name}: ${[...set].sort().join(", ")}`)
    expect(duplicates).toEqual([])
  })
})
