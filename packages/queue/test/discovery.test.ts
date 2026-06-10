import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-discovery"
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

  it("discovers queue names for vite suffix and server entrypoints", async () => {
    const viteRootDir = await createTempDir("vitehub-queue-vite-discovery-")
    await mkdir(join(viteRootDir, "src", "emails"), { recursive: true })
    await writeFile(join(viteRootDir, "src", "emails", "welcome.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(viteRootDir, "src", "billing.queue.ts"), "export default null\n", "utf8")

    const serverScanDir = await createTempDir("vitehub-queue-server-discovery-")
    await mkdir(join(serverScanDir, "queues", "emails"), { recursive: true })
    await mkdir(join(serverScanDir, "queues", "billing"), { recursive: true })
    await writeFile(join(serverScanDir, "queues", "emails", "welcome.ts"), "export default null\n", "utf8")
    await writeFile(join(serverScanDir, "queues", "billing", "index.ts"), "export default null\n", "utf8")
    await writeFile(join(serverScanDir, "queues", "welcome.d.ts"), "export type Welcome = string\n", "utf8")

    expect(discoverQueueDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
    }).map(definition => definition.name)).toEqual([
      "billing",
      "emails/welcome",
    ])

    expect(discoverQueueDefinitions({
      mode: "server-queues",
      scanDirs: [serverScanDir],
    }).map(definition => definition.name)).toEqual([
      "billing",
      "emails/welcome",
    ])
  })

  it("discovers server queue directories through Vite discovery", async () => {
    const rootDir = await createTempDir("vitehub-queue-vite-server-discovery-")
    await mkdir(join(rootDir, "server", "queues", "emails"), { recursive: true })
    await mkdir(join(rootDir, "server", "queues", "billing"), { recursive: true })
    await writeFile(join(rootDir, "server", "queues", "emails", "welcome.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "server", "queues", "billing", "index.ts"), "export default null\n", "utf8")

    expect(discoverQueueDefinitions({ rootDir })).toMatchObject([
      { name: "billing", source: "server-queues" },
      { name: "emails/welcome", source: "server-queues" },
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

    const firstServerScanDir = await createTempDir("vitehub-queue-server-first-")
    const secondServerScanDir = await createTempDir("vitehub-queue-server-second-")
    await mkdir(join(firstServerScanDir, "queues"), { recursive: true })
    await mkdir(join(secondServerScanDir, "queues"), { recursive: true })
    await writeFile(join(firstServerScanDir, "queues", "welcome.ts"), "export default null\n", "utf8")
    await writeFile(join(secondServerScanDir, "queues", "welcome.ts"), "export default null\n", "utf8")

    expect(() => discoverQueueDefinitions({
      mode: "server-queues",
      scanDirs: [firstServerScanDir, secondServerScanDir],
    })).toThrow(/Duplicate queue name/)
  })

  it("deduplicates repeated scan roots without suppressing real duplicate names", async () => {
    const viteRootDir = await createTempDir("vitehub-queue-vite-root-dedupe-")
    await writeFile(join(viteRootDir, "welcome.queue.ts"), "export default null\n", "utf8")

    expect(discoverQueueDefinitions({
      mode: "vite-suffix",
      rootDir: viteRootDir,
      scanDirs: [viteRootDir],
    })).toEqual([
      expect.objectContaining({
        name: "welcome",
        source: "vite-suffix",
      }),
    ])
  })
})
