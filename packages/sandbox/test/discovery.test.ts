import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-discovery"
import { discoverSandboxDefinitions, discoverServerSandboxDefinitions } from "../src/discovery.ts"

const tempDirs: string[] = []

async function createTempDir(prefix: string) {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(rootDir)
  return rootDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("discoverServerSandboxDefinitions", () => {
  it("discovers sandbox names for Vite suffix and server entrypoints", async () => {
    const rootDir = await createTempDir("vitehub-sandbox-vite-discovery-")
    await mkdir(join(rootDir, "src", "content"), { recursive: true })
    await mkdir(join(rootDir, "server", "sandboxes", "billing"), { recursive: true })
    await writeFile(join(rootDir, "src", "release-notes.sandbox.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "src", "content", "summary.sandbox.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "server", "sandboxes", "billing", "index.ts"), "export default null\n", "utf8")

    expect(discoverSandboxDefinitions({ rootDir }).map(definition => ({
      name: definition.name,
      source: definition.source,
    }))).toEqual([
      { name: "billing", source: "server-sandboxes" },
      { name: "content/summary", source: "vite-suffix" },
      { name: "release-notes", source: "vite-suffix" },
    ])
  })

  it("discovers sandbox names from server/sandboxes directories", async () => {
    const scanDir = await createTempDir("vitehub-sandbox-server-discovery-")
    await mkdir(join(scanDir, "sandboxes", "content"), { recursive: true })
    await mkdir(join(scanDir, "sandboxes", "billing"), { recursive: true })
    await writeFile(join(scanDir, "sandboxes", "content", "summary.ts"), "export default null\n", "utf8")
    await writeFile(join(scanDir, "sandboxes", "billing", "index.ts"), "export default null\n", "utf8")
    await writeFile(join(scanDir, "sandboxes", "ignored.d.ts"), "export type Ignored = string\n", "utf8")

    expect(discoverServerSandboxDefinitions([scanDir]).map(definition => definition.name)).toEqual([
      "billing",
      "content/summary",
    ])
  })

  it("rejects duplicate sandbox names across server scan dirs", async () => {
    const firstScanDir = await createTempDir("vitehub-sandbox-server-first-")
    const secondScanDir = await createTempDir("vitehub-sandbox-server-second-")
    await mkdir(join(firstScanDir, "sandboxes"), { recursive: true })
    await mkdir(join(secondScanDir, "sandboxes"), { recursive: true })
    await writeFile(join(firstScanDir, "sandboxes", "release-notes.ts"), "export default null\n", "utf8")
    await writeFile(join(secondScanDir, "sandboxes", "release-notes.ts"), "export default null\n", "utf8")

    expect(() => discoverServerSandboxDefinitions([firstScanDir, secondScanDir])).toThrow(/Duplicate sandbox name/)
  })

  it("creates a runtime registry file", async () => {
    const rootDir = await createTempDir("vitehub-sandbox-registry-")
    const registryFile = join(rootDir, ".vitehub", "sandbox", "registry.mjs")
    const sourceFile = join(rootDir, "definition.mjs")
    await writeFile(sourceFile, "export default null\n", "utf8")

    expect(createRuntimeRegistryContents(registryFile, [{
      handler: sourceFile,
      name: "release-notes",
    }])).toContain('"release-notes": async () => import(')
  })
})
