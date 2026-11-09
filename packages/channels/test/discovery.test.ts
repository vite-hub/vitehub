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

async function touch(root: string, path: string, source = "import { defineChannel } from 'vite-hub/channels'\nexport default defineChannel({ adapter: { kind: 'log', send() { return {} } } })\n"): Promise<void> {
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

  it("lists every defineChannel() module in server/channels", async () => {
    const root = await createTempProject()
    await touch(root, "server/channels/teams/index.ts", [
      "import { defineChannel } from 'vite-hub/channels'",
      "import { teams } from 'vite-hub/agent/channels'",
      "export default defineChannel({ adapter: teams() })",
      "",
    ].join("\n"))
    await touch(root, "server/channels/stripe.ts", [
      "import { defineChannel, stripe } from 'vite-hub/channels'",
      "const channel = defineChannel({ adapter: stripe() })",
      "export { channel as default }",
      "",
    ].join("\n"))

    expect(discoverChannelDefinitions({ mode: "server-channels", scanDirs: [join(root, "server")] }).map(definition => definition.name)).toEqual(["stripe", "teams"])
  })

  it("skips factories, classes, primitives, and modules without a default export", async () => {
    const root = await createTempProject()
    await touch(root, "server/channels/arrow.ts", "export default (kind: string) => ({ adapter: { kind } })\n")
    await touch(root, "server/channels/declared.ts", "export default function createChannel() { return {} }\n")
    await touch(root, "server/channels/named.ts", "function createChannel() { return {} }\nexport { createChannel as default }\n")
    await touch(root, "server/channels/helpers.ts", "export const format = (text: string) => text.trim()\n")
    await touch(root, "server/channels/types.ts", "export type Message = { text: string }\n")
    await touch(root, "server/channels/shape.ts", "export default interface Shape { text: string }\n")
    await touch(root, "server/channels/client.ts", "class Client {}\nexport default Client\n")
    await touch(root, "server/channels/inline-class.ts", "export default class {}\n")
    await touch(root, "server/channels/count.ts", "export default 1\n")
    await touch(root, "server/channels/empty.ts", "export default null\n")
    await touch(root, "server/channels/list.ts", "export default []\n")
    await touch(root, "server/channels/label.ts", "export default `label`\n")
    await touch(root, "server/channels/undefined.ts", "export default undefined\n")
    await touch(root, "server/channels/void.ts", "export default void 0\n")
    await touch(root, "server/channels/negative.ts", "export default -1\n")

    expect(discoverChannelDefinitions({ rootDir: root })).toEqual([])
  })

  it("skips helper object modules in a mixed flat channel directory", async () => {
    const root = await createTempProject()
    await touch(root, "server/channels/alerts.ts", "export default { adapter: { kind: 'log', send() { return {} } } }\n")
    await touch(root, "server/channels/shared.ts", "export default { format(text: string) { return text.trim() } }\n")

    expect(discoverChannelDefinitions({ rootDir: root })).toEqual([
      { handler: join(root, "server/channels/alerts.ts"), name: "alerts", source: "server-channels" },
    ])
  })

  it("keeps modules that it cannot read statically", async () => {
    const root = await createTempProject()
    await touch(root, "server/channels/alerts.ts", "const adapter = createAdapter()\nexport default { ...adapter }\n")
    await touch(root, "server/channels/pager.ts", "import { definition } from './shared/pager-definition'\nexport default definition\n")
    await touch(root, "server/channels/relay.ts", "export * from './shared/relay-definition'\n")
    await touch(root, "server/channels/broken.ts", "export default {\n")

    expect(discoverChannelDefinitions({ rootDir: root }).map(definition => definition.name)).toEqual(["alerts", "broken", "pager", "relay"])
  })
})
