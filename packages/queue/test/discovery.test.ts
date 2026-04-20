import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createQueueRegistryContents, discoverQueueDefinitions } from "../src/discovery.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("discoverQueueDefinitions", () => {
  it("discovers nested *.queue files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-queue-discovery-"))
    directories.push(rootDir)
    await mkdir(join(rootDir, "src", "emails"), { recursive: true })
    await writeFile(join(rootDir, "src", "emails", "welcome.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "src", "billing.queue.ts"), "export default null\n", "utf8")

    const definitions = discoverQueueDefinitions({ mode: "vite-suffix", rootDir })
    expect(definitions.map(definition => definition.name)).toEqual([
      "billing",
      "emails/welcome",
    ])
  })

  it("throws on duplicate discovered names", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-queue-duplicate-"))
    const scanDir = await mkdtemp(join(tmpdir(), "vitehub-queue-duplicate-scan-"))
    directories.push(rootDir)
    directories.push(scanDir)
    await writeFile(join(rootDir, "welcome.queue.ts"), "export default null\n", "utf8")
    await writeFile(join(scanDir, "welcome.queue.ts"), "export default null\n", "utf8")

    expect(() => discoverQueueDefinitions({ mode: "vite-suffix", rootDir, scanDirs: [scanDir] })).toThrow(/Duplicate queue name/)
  })

  it("creates a runtime registry file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-queue-registry-"))
    directories.push(rootDir)
    const registryFile = join(rootDir, ".vitehub", "queue", "registry.mjs")
    const sourceFile = join(rootDir, "welcome.queue.ts")
    await writeFile(sourceFile, "export default null\n", "utf8")

    expect(createQueueRegistryContents(registryFile, [{
      handler: sourceFile,
      name: "welcome",
      source: "vite-suffix",
    }])).toContain('"welcome": async () => import(')
  })

  it("discovers Nitro queues from server/queues only", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-discovery-"))
    directories.push(rootDir)
    await mkdir(join(rootDir, "queues", "emails"), { recursive: true })
    await writeFile(join(rootDir, "queues", "emails", "welcome.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "queues", "billing", "index.ts"), "export default null\n", "utf8").catch(async () => {
      await mkdir(join(rootDir, "queues", "billing"), { recursive: true })
      await writeFile(join(rootDir, "queues", "billing", "index.ts"), "export default null\n", "utf8")
    })
    await writeFile(join(rootDir, "welcome.queue.ts"), "export default null\n", "utf8")

    const definitions = discoverQueueDefinitions({
      mode: "nitro-server-queues",
      scanDirs: [rootDir],
    })

    expect(definitions.map(definition => definition.name)).toEqual([
      "billing",
      "emails/welcome",
    ])
  })

  it("throws on duplicate Nitro queue names across scan roots", async () => {
    const firstScanDir = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-first-"))
    const secondScanDir = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-second-"))
    directories.push(firstScanDir)
    directories.push(secondScanDir)

    await mkdir(join(firstScanDir, "queues"), { recursive: true })
    await mkdir(join(secondScanDir, "queues"), { recursive: true })
    await writeFile(join(firstScanDir, "queues", "welcome.ts"), "export default null\n", "utf8")
    await writeFile(join(secondScanDir, "queues", "welcome.ts"), "export default null\n", "utf8")

    expect(() => discoverQueueDefinitions({
      mode: "nitro-server-queues",
      scanDirs: [firstScanDir, secondScanDir],
    })).toThrow(/Duplicate queue name/)
  })
})
