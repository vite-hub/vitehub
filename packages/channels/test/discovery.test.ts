import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { discoverChannelDefinitions } from "../src/discovery.ts"

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-channels-discovery-"))
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

describe("discoverChannelDefinitions", () => {
  it("discovers server channels by path and Vite channels by suffix", async () => {
    const root = await createTempProject()
    await touch(root, "server/channels/alerts.ts")
    await touch(root, "src/incidents.channel.ts")

    expect(discoverChannelDefinitions({ rootDir: root })).toEqual([
      { handler: join(root, "server/channels/alerts.ts"), name: "alerts", source: "server-channels" },
      { handler: join(root, "src/incidents.channel.ts"), name: "incidents", source: "vite-suffix" },
    ])
  })

  it("rejects duplicate names across conventions", async () => {
    const root = await createTempProject()
    await touch(root, "server/channels/alerts.ts")
    await touch(root, "src/alerts.channel.ts")

    expect(() => discoverChannelDefinitions({ rootDir: root })).toThrow("Duplicate channel name \"alerts\"")
  })

  it("treats suffixed files inside server channels as directory definitions", async () => {
    const root = await createTempProject()
    await touch(root, "server/channels/alerts.channel.ts")

    expect(discoverChannelDefinitions({ rootDir: root })).toEqual([
      { handler: join(root, "server/channels/alerts.channel.ts"), name: "alerts.channel", source: "server-channels" },
    ])
  })
})
