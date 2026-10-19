import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { loadFeatureDefinitions, normalizeDefinitionName } from "../src/internal/shared/feature-definitions.ts"

const tempDirs: string[] = []

async function createTempRoot() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-sandbox-task-definitions-"))
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
    await mkdir(join(srcDir, "server/sandbox-tasks"), { recursive: true })
    await mkdir(join(srcDir, "tools"), { recursive: true })
    await writeFile(join(srcDir, "server/sandbox-tasks/release-notes.sandbox-task.ts"), "export default {}")
    await writeFile(join(srcDir, "tools/summary.sandbox-task.ts"), "export default {}")

    const result = await loadFeatureDefinitions({
      feature: "sandbox-task",
      scanRoots: [srcDir],
      subdir: "sandbox-tasks",
      srcScan: {
        mode: "recursive",
        filter: relativePath => relativePath.endsWith(".sandbox-task.ts"),
        normalizeName(relativePath) {
          return normalizeDefinitionName(relativePath.replace(/\.sandbox-task(\.[cm]?[tj]s)$/i, "$1"))
        },
      },
    })

    expect(result.definitions.map(definition => definition._meta.sourcePath)).toEqual([
      join(srcDir, "server/sandbox-tasks/release-notes.sandbox-task.ts"),
      join(srcDir, "tools/summary.sandbox-task.ts"),
    ])
    expect(result.definitions.map(definition => definition.name)).toEqual([
      "release-notes",
      "tools/summary",
    ])
    expect(result.definitions).toHaveLength(2)
  })
})
