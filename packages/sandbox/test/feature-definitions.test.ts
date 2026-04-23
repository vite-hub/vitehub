import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { loadFeatureDefinitions, normalizeDefinitionName } from "../src/internal/shared/feature-definitions.ts"

const tempDirs: string[] = []

async function createTempRoot() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-sandbox-definitions-"))
  tempDirs.push(rootDir)
  return rootDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("loadFeatureDefinitions", () => {
  it("does not double-register definitions from recursive src scans", async () => {
    const rootDir = await createTempRoot()
    const srcDir = join(rootDir, "src")
    await mkdir(join(srcDir, "server/sandboxes"), { recursive: true })
    await mkdir(join(srcDir, "tools"), { recursive: true })
    await writeFile(join(srcDir, "server/sandboxes/release-notes.sandbox.ts"), "export default {}")
    await writeFile(join(srcDir, "tools/summary.sandbox.ts"), "export default {}")

    const result = await loadFeatureDefinitions({
      feature: "sandbox",
      scanRoots: [srcDir],
      subdir: "sandboxes",
      srcScan: {
        mode: "recursive",
        filter: relativePath => relativePath.endsWith(".sandbox.ts"),
        normalizeName(relativePath) {
          return normalizeDefinitionName(relativePath.replace(/\.sandbox(\.[cm]?[tj]s)$/i, "$1"))
        },
      },
    })

    expect(result.definitions.map(definition => definition._meta.sourcePath)).toEqual([
      join(srcDir, "server/sandboxes/release-notes.sandbox.ts"),
      join(srcDir, "tools/summary.sandbox.ts"),
    ])
    expect(result.definitions).toHaveLength(2)
  })
})
