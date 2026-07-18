import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "..")
const effectVersion = "4.0.0-beta.99"

async function readFiles(dir: string, predicate: (path: string) => boolean): Promise<string[]> {
  if (!existsSync(dir)) return []
  const files = (await readdir(dir, { recursive: true }))
    .filter(path => predicate(path))
  return Promise.all(files.map(path => readFile(join(dir, path), "utf8")))
}

async function effectOwners() {
  const packagesDir = join(repoRoot, "packages")
  const owners: string[] = []
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const packageDir = join(packagesDir, entry.name)
    const source = (await readFiles(join(packageDir, "src"), path => /\.[cm]?[jt]sx?$/.test(path))).join("\n")
    if (/(?:from\s*|import\s*(?:\(\s*)?)["']effect(?:\/[^"']*)?["']/.test(source)) owners.push(packageDir)
  }
  return owners
}

function lockOwnerForV3References(lockfile: string) {
  let owner = ""
  const owners: string[] = []
  for (const line of lockfile.split("\n")) {
    const packageEntry = /^  (\S.*):$/.exec(line)
    if (packageEntry) owner = packageEntry[1]!
    if (/effect@3\.|effect:\s*[\^~]?3\./.test(line)) owners.push(owner)
  }
  return owners
}

describe("Effect ownership", () => {
  it("pins every ViteHub Effect importer to the owned Effect 4 catalog", async () => {
    const workspace = await readFile(join(repoRoot, "pnpm-workspace.yaml"), "utf8")
    expect(workspace).toContain(`  effect:\n    effect: ${effectVersion}`)

    const owners = await effectOwners()
    expect(owners.length).toBeGreaterThan(0)
    for (const packageDir of owners) {
      const manifestPath = join(packageDir, "package.json")
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { dependencies?: Record<string, string> }
      expect(manifest.dependencies?.effect, manifestPath).toBe("catalog:effect")

      const effectPackage = createRequire(manifestPath).resolve("effect/package.json")
      const resolved = JSON.parse(await readFile(effectPackage, "utf8")) as { version: string }
      expect(resolved.version, packageDir).toBe(effectVersion)

      const declarations = (await readFiles(join(packageDir, "dist"), path => path.endsWith(".d.ts"))).join("\n")
      expect(declarations, packageDir).not.toMatch(/(?:from\s*|import\s*(?:\(\s*)?)["']effect(?:\/[^"']*)?["']/)

      const bundles = (await readFiles(join(packageDir, "dist"), path => /\.[cm]?js$/.test(path))).join("\n")
      expect(bundles, packageDir).not.toMatch(/effect@3\.|3\.17\.7/)
    }
  })

  it("isolates the optional Effect 3 subtree to UploadThing", async () => {
    const lockfile = await readFile(join(repoRoot, "pnpm-lock.yaml"), "utf8")
    const owners = lockOwnerForV3References(lockfile)
    expect(owners.length).toBeGreaterThan(0)
    expect(owners.filter(owner => !(
      /^effect@3\./.test(owner)
      || owner.startsWith("'@effect/platform@")
      || owner.startsWith("'@uploadthing/shared@")
      || owner.startsWith("uploadthing@")
    ))).toEqual([])
  })
})
