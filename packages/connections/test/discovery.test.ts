import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { discoverConnectionDefinitions } from "../src/discovery.ts"

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-connections-discovery-"))
  tempDirs.push(root)
  return root
}

async function touch(root: string, path: string): Promise<void> {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, "export default {}\n")
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("discoverConnectionDefinitions", () => {
  it("discovers server connections by file path", async () => {
    const root = await createTempProject()
    await touch(root, "server/connections/gmail.ts")
    await touch(root, "server/connections/google/drive.ts")
    await touch(root, "server/connections/billing/index.ts")

    expect(discoverConnectionDefinitions({ rootDir: root })).toEqual([
      { handler: join(root, "server/connections/billing/index.ts"), name: "billing", source: "server-connections" },
      { handler: join(root, "server/connections/gmail.ts"), name: "gmail", source: "server-connections" },
      { handler: join(root, "server/connections/google/drive.ts"), name: "google/drive", source: "server-connections" },
    ])
  })

  it("rejects a Connection name longer than the management routes accept", async () => {
    const root = await createTempProject()
    await touch(root, `server/connections/${"n".repeat(129)}.ts`)
    expect(() => discoverConnectionDefinitions({ rootDir: root })).toThrow("Invalid Connection request.")
  })

  it("returns no definitions without a connections directory", async () => {
    const root = await createTempProject()
    await touch(root, "server/channels/alerts.ts")

    expect(discoverConnectionDefinitions({ rootDir: root })).toEqual([])
  })

  it("uses configured server directories instead of the default", async () => {
    const root = await createTempProject()
    await touch(root, "server/connections/ignored.ts")
    await touch(root, "custom-server/connections/gmail.ts")

    expect(discoverConnectionDefinitions({ rootDir: root, serverDirs: [join(root, "custom-server")] })).toEqual([
      { handler: join(root, "custom-server/connections/gmail.ts"), name: "gmail", source: "server-connections" },
    ])
  })

  it("rejects duplicate names across server directories", async () => {
    const root = await createTempProject()
    await touch(root, "a/connections/gmail.ts")
    await touch(root, "b/connections/gmail.ts")

    expect(() => discoverConnectionDefinitions({ rootDir: root, serverDirs: [join(root, "a"), join(root, "b")] }))
      .toThrow("Duplicate connection name \"gmail\"")
  })
})
