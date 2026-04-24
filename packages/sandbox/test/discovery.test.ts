import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeRegistryContents } from "@vitehub/internal/definition-discovery"
import { discoverNitroSandboxDefinitions } from "../src/discovery.ts"

const tempDirs: string[] = []

async function createTempDir(prefix: string) {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(rootDir)
  return rootDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("discoverNitroSandboxDefinitions", () => {
  it("discovers sandbox names from Nitro server/sandboxes directories", async () => {
    const scanDir = await createTempDir("vitehub-sandbox-nitro-discovery-")
    await mkdir(join(scanDir, "sandboxes", "content"), { recursive: true })
    await mkdir(join(scanDir, "sandboxes", "billing"), { recursive: true })
    await writeFile(join(scanDir, "sandboxes", "content", "summary.ts"), "export default null\n", "utf8")
    await writeFile(join(scanDir, "sandboxes", "billing", "index.ts"), "export default null\n", "utf8")
    await writeFile(join(scanDir, "sandboxes", "ignored.d.ts"), "export type Ignored = string\n", "utf8")

    expect(discoverNitroSandboxDefinitions([scanDir]).map(definition => definition.name)).toEqual([
      "billing",
      "content/summary",
    ])
  })

  it("rejects duplicate sandbox names across Nitro scan dirs", async () => {
    const firstScanDir = await createTempDir("vitehub-sandbox-nitro-first-")
    const secondScanDir = await createTempDir("vitehub-sandbox-nitro-second-")
    await mkdir(join(firstScanDir, "sandboxes"), { recursive: true })
    await mkdir(join(secondScanDir, "sandboxes"), { recursive: true })
    await writeFile(join(firstScanDir, "sandboxes", "release-notes.ts"), "export default null\n", "utf8")
    await writeFile(join(secondScanDir, "sandboxes", "release-notes.ts"), "export default null\n", "utf8")

    expect(() => discoverNitroSandboxDefinitions([firstScanDir, secondScanDir])).toThrow(/Duplicate sandbox name/)
  })

  it("creates a runtime registry file", async () => {
    const rootDir = await createTempDir("vitehub-sandbox-registry-")
    const registryFile = join(rootDir, ".vitehub", "sandbox", "nitro-registry.mjs")
    const sourceFile = join(rootDir, "definition.mjs")
    await writeFile(sourceFile, "export default null\n", "utf8")

    expect(createRuntimeRegistryContents(registryFile, [{
      handler: sourceFile,
      name: "release-notes",
    }])).toContain('"release-notes": async () => import(')
  })
})
