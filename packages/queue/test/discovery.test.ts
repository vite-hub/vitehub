import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeRegistryContents } from "@vitehub/internal/definition-discovery"
import { discoverQueueDefinitions } from "../src/discovery.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createTempDir(prefix: string) {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  directories.push(rootDir)
  return rootDir
}

describe("discoverQueueDefinitions", () => {
  it("creates a runtime registry file", async () => {
    const rootDir = await createTempDir("vitehub-queue-registry-")
    const registryFile = join(rootDir, ".vitehub", "queue", "registry.mjs")
    const sourceFile = join(rootDir, "welcome.queue.ts")
    await writeFile(sourceFile, "export default null\n", "utf8")

    expect(createRuntimeRegistryContents(registryFile, [{
      handler: sourceFile,
      name: "welcome",
    }])).toContain('"welcome": async () => import(')
  })

  it("discovers queue names for vite and nitro entrypoints", async () => {
    const viteRootDir = await createTempDir("vitehub-queue-vite-discovery-")
    await mkdir(join(viteRootDir, "src", "emails"), { recursive: true })
    await writeFile(join(viteRootDir, "src", "emails", "welcome.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(viteRootDir, "src", "billing.queue.ts"), "export default null\n", "utf8")

    const nitroScanDir = await createTempDir("vitehub-queue-nitro-discovery-")
    await mkdir(join(nitroScanDir, "queues", "emails"), { recursive: true })
    await mkdir(join(nitroScanDir, "queues", "billing"), { recursive: true })
    await writeFile(join(nitroScanDir, "queues", "emails", "welcome.ts"), "export default null\n", "utf8")
    await writeFile(join(nitroScanDir, "queues", "billing", "index.ts"), "export default null\n", "utf8")
    await writeFile(join(nitroScanDir, "queues", "welcome.d.ts"), "export type Welcome = string\n", "utf8")

    expect(discoverQueueDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual([
      "billing",
      "emails/welcome",
    ])

    expect(discoverQueueDefinitions({
      mode: "nitro-server-queues",
      scanDirs: [nitroScanDir],
    }).map(definition => definition.name)).toEqual([
      "billing",
      "emails/welcome",
    ])
  })

  it("rejects duplicate queue names across discovery roots", async () => {
    const viteRootDir = await createTempDir("vitehub-queue-vite-duplicate-")
    const viteScanDir = await createTempDir("vitehub-queue-vite-duplicate-scan-")
    await writeFile(join(viteRootDir, "welcome.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(viteScanDir, "welcome.queue.ts"), "export default null\n", "utf8")

    expect(() => discoverQueueDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
      scanDirs: [viteScanDir],
    })).toThrow(/Duplicate queue name/)

    const firstNitroScanDir = await createTempDir("vitehub-queue-nitro-first-")
    const secondNitroScanDir = await createTempDir("vitehub-queue-nitro-second-")
    await mkdir(join(firstNitroScanDir, "queues"), { recursive: true })
    await mkdir(join(secondNitroScanDir, "queues"), { recursive: true })
    await writeFile(join(firstNitroScanDir, "queues", "welcome.ts"), "export default null\n", "utf8")
    await writeFile(join(secondNitroScanDir, "queues", "welcome.ts"), "export default null\n", "utf8")

    expect(() => discoverQueueDefinitions({
      mode: "nitro-server-queues",
      scanDirs: [firstNitroScanDir, secondNitroScanDir],
    })).toThrow(/Duplicate queue name/)
  })
})
