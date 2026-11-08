import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { inspectQueueResources } from "../src/inspect.ts"
import { getCloudflareQueueName } from "../src/internal/cloudflare-resource-name.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Queue resource inspection", () => {
  it("lists the Cloudflare Queue that each Definition binds by name", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-queue-resources-"))
    directories.push(rootDir)
    await writeFile(join(rootDir, "welcome.queue.ts"), "export default null\n", "utf8")

    expect(inspectQueueResources({ namePrefix: "preview-", projectRoot: rootDir, rootDir })).toEqual([{
      binding: expect.any(String),
      definition: "welcome",
      host: "cloudflare",
      kind: "cloudflare-queue",
      name: getCloudflareQueueName("welcome", "preview-"),
      owner: "queue",
      source: "name",
    }])
  })
})
