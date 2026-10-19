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

async function touch(root: string, path: string, source = "export default {}\n"): Promise<void> {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, source)
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

  it("normalizes suffixed files inside server channels to the same channel name", async () => {
    const root = await createTempProject()
    await touch(root, "server/channels/alerts.channel.ts")

    expect(discoverChannelDefinitions({ rootDir: root })).toEqual([
      { handler: join(root, "server/channels/alerts.channel.ts"), name: "alerts", source: "server-channels" },
    ])
  })

  it("treats a folder with an index module as one channel and its other files as helpers", async () => {
    const root = await createTempProject()
    await touch(root, "server/channels/alerts.ts")
    await touch(root, "server/channels/teams/index.ts")
    await touch(root, "server/channels/teams/client.ts")
    await touch(root, "server/channels/teams/cards/index.ts")
    await touch(root, "server/channels/ops/pager.ts")

    const expected = [
      { handler: join(root, "server/channels/alerts.ts"), name: "alerts", source: "server-channels" },
      { handler: join(root, "server/channels/ops/pager.ts"), name: "ops/pager", source: "server-channels" },
      { handler: join(root, "server/channels/teams/index.ts"), name: "teams", source: "server-channels" },
    ]
    expect(discoverChannelDefinitions({ rootDir: root })).toEqual(expected)
    expect(discoverChannelDefinitions({ mode: "server-channels", scanDirs: [join(root, "server")] })).toEqual(expected)
  })

  it("keeps a root index module as a channel named index", async () => {
    const root = await createTempProject()
    await touch(root, "server/channels/index.ts")
    await touch(root, "server/channels/alerts.ts")

    expect(discoverChannelDefinitions({ rootDir: root }).map(definition => definition.name)).toEqual(["alerts", "index"])
  })

  it("lists only outbound Channels when Agent Channels share server/channels", async () => {
    const root = await createTempProject()
    await touch(root, "server/channels/teams/index.ts", [
      "import { defineOutboundChannel } from 'vite-hub/channels'",
      "export default defineOutboundChannel({ connectors: { teams: { send() {} } } })",
      "",
    ].join("\n"))
    await touch(root, "server/channels/airtable/index.ts", [
      "import { defineChannel } from 'vite-hub/agent/channels'",
      "export const airtable = defineChannel('airtable', {})",
      "export default airtable",
      "",
    ].join("\n"))
    await touch(root, "server/channels/mailbox/index.ts", [
      "import { defineChannel as channel } from '@vite-hub/agent/channels'",
      "export default (channel('mailbox', {}) satisfies object)",
      "",
    ].join("\n"))
    await touch(root, "server/channels/github/index.ts", [
      "import * as channels from 'vite-hub/agent/channels'",
      "const github = channels.defineChannel('github', {})",
      "export { github as default }",
      "",
    ].join("\n"))

    const expected = [
      { handler: join(root, "server/channels/teams/index.ts"), name: "teams", source: "server-channels" },
    ]
    expect(discoverChannelDefinitions({ rootDir: root })).toEqual(expected)
    expect(discoverChannelDefinitions({ mode: "server-channels", scanDirs: [join(root, "server")] })).toEqual(expected)
  })

  it("skips Channel factories and modules without a default or connectors export", async () => {
    const root = await createTempProject()
    await touch(root, "server/channels/arrow.ts", "export default (name: string) => ({ connectors: { [name]: { send() {} } } })\n")
    await touch(root, "server/channels/declared.ts", "export default function createChannel() { return {} }\n")
    await touch(root, "server/channels/named.ts", "function createChannel() { return {} }\nexport { createChannel as default }\n")
    await touch(root, "server/channels/helpers.ts", "export const format = (text: string) => text.trim()\n")
    await touch(root, "server/channels/types.ts", "export type Message = { text: string }\n")

    expect(discoverChannelDefinitions({ rootDir: root })).toEqual([])
  })

  it("keeps modules that export connectors or that it cannot read statically", async () => {
    const root = await createTempProject()
    await touch(root, "server/channels/alerts.ts", "export const connectors = { log: { send() {} } }\n")
    await touch(root, "server/channels/pager.ts", "import { definition } from './shared/pager-definition'\nexport default definition\n")
    await touch(root, "server/channels/relay.ts", "export * from './shared/relay-definition'\n")
    await touch(root, "server/channels/broken.ts", "export default {\n")

    expect(discoverChannelDefinitions({ rootDir: root }).map(definition => definition.name)).toEqual(["alerts", "broken", "pager", "relay"])
  })
})
