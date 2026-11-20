import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, upgradeCodemods } from "../src/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/channels-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function migrate(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), contents)
  }
  const run = await runCodemod("channels", { cwd, dryRun: true })
  return { after: Object.fromEntries(run.result.edits.flatMap(edit => edit.after === null ? [] : [[edit.path, edit.after]])), cwd, run }
}

describe("channels", () => {
  it("runs in the release upgrade and is not detected after it", async () => {
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("channels")
    const { cwd } = await migrate({
      "server/channels/team.ts": "import { defineChannel } from 'vite-hub/channels'\nimport { http } from 'vite-hub/agent/channels'\n\nexport default defineChannel({ adapter: http() })\n",
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("channels")
    await runCodemod("channels", { cwd, dryRun: false })
    expect(await readFile(join(cwd, "server/channels/team.ts"), "utf8")).toBe("import { defineChannel } from 'vite-hub/channels'\nimport { channelAdapter } from 'vite-hub/channels/adapters'\n\nexport default defineChannel({ adapter: channelAdapter('http') })\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("channels")
  })

  it("replaces http() with channelAdapter(\"http\") and moves the path to the adapters entry", async () => {
    const { after } = await migrate({
      "server/agents/support.ts": [
        "import { defineAgent } from \"vite-hub/agent\"",
        "import { http, slack } from \"vite-hub/agent/channels\"",
        "",
        "export default defineAgent({",
        "  channels: { portal: http(({ route: true })), web: http(), slack: slack() },",
        "})",
        "",
      ].join("\n"),
    })
    expect(after["server/agents/support.ts"]).toBe([
      "import { defineAgent } from \"vite-hub/agent\"",
      "import { channelAdapter, slack } from \"vite-hub/channels/adapters\"",
      "",
      "export default defineAgent({",
      "  channels: { portal: channelAdapter(\"http\", ({ route: true })), web: channelAdapter(\"http\"), slack: slack() },",
      "})",
      "",
    ].join("\n"))
  })

  it("keeps aliases and does not capture a shadowed channelAdapter", async () => {
    const { after } = await migrate({
      "server/agents/a.ts": "import { channelAdapter, http } from '@vite-hub/agent/channels'\nexport function configure(channelAdapter: (kind: string) => string) { return [http({ route: true }), channelAdapter('portal')] }\n",
      "server/agents/b.ts": "import { http as generic } from '@vite-hub/agent/channels'\nexport const b = generic()\n",
    })
    expect(after).toEqual({
      "server/agents/a.ts": "import { channelAdapter, channelAdapter as channelAdapter2 } from '@vite-hub/agent/channels'\nexport function configure(channelAdapter: (kind: string) => string) { return [channelAdapter2('http', { route: true }), channelAdapter('portal')] }\n",
      "server/agents/b.ts": "import { channelAdapter as generic } from '@vite-hub/agent/channels'\nexport const b = generic('http')\n",
    })
  })

  it.each([false, true])("keeps split imports valid (existing adapter first: %s)", async (adapterFirst) => {
    const oldImport = "import { http } from 'vite-hub/agent/channels'"
    const otherImport = "import { slack, channelAdapter } from 'vite-hub/agent/channels'"
    const imports = adapterFirst ? [otherImport, oldImport] : [oldImport, otherImport]
    const { after, run } = await migrate({ "split.ts": [...imports, "export const channels = [http /* (legacy) */ (), slack(), channelAdapter('custom')]"].join("\n") })
    expect(run.result.followUps).toEqual([])
    expect(after["split.ts"]).toBe([...imports.map(statement => statement.replace("{ http }", "{ channelAdapter as channelAdapter2 }").replace("vite-hub/agent/channels", "vite-hub/channels/adapters")),
      "export const channels = [channelAdapter2 /* (legacy) */ ('http'), slack(), channelAdapter('custom')]"].join("\n"))
  })

  it.each([
    ["import { http } from 'vite-hub/agent/channels'\nhttp<AgentRuntimeConfig>()", "typed calls"],
    ["import { http } from 'vite-hub/agent/channels'\nhttp({ route: { admission: { context({ auth, body }) { return { auth, body } } } } })", "typed routes"],
    ["import * as channels from 'vite-hub/agent/channels'\nchannels.http()", "namespace import"],
    ["const { http } = await import('@vite-hub/agent/channels')\nhttp()", "module load"],
    ["export { http as portal } from 'vite-hub/agent/channels'", "removed"],
    ["import { defineChannel } from 'vite-hub/channels'\nvi.mock('vite-hub/agent/channels', () => ({ slack: fakeSlack }))", "mock"],
    ["import { http } from 'vite-hub/agent/channels'\nvi.doMock(import('vite-hub/agent/channels'), () => ({ http: fakeHttp }))\nhttp()", "mock"],
  ])("reports manual work for %s and only moves the path", async (source, message) => {
    const { after, run } = await migrate({ "manual.ts": source })
    expect(after["manual.ts"] ?? source).toBe(source.replaceAll("'vite-hub/agent/channels'", "'vite-hub/channels/adapters'"))
    expect(run.result.followUps).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining(message) })]))
  })

  it("reports an http reference that is not a call, and leaves other http names", async () => {
    const { after, run } = await migrate({
      "server/agents/factory.ts": "import { http } from 'vite-hub/agent/channels'\nexport const make = http\n",
      "server/api/ping.ts": "import http from 'node:http'\nexport const server = http.createServer()\n",
    })
    expect(after).toEqual({ "server/agents/factory.ts": "import { http } from 'vite-hub/channels/adapters'\nexport const make = http\n" })
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/agents/factory.ts", line: 2, message: expect.stringContaining("channelAdapter(\"http\", options)") })])
  })

  it.each([
    "<script>\nimport { http } from 'vite-hub/agent/channels'\n</script>\n<script setup>\nconst channel = http()\n</script>",
    "<script setup>\nimport { http as makeChannel } from 'vite-hub/agent/channels'\n</script>\n<template>\n<div>{{ makeChannel() }}</div>\n</template>",
  ])("reports Vue references outside the parsed script", async (source) => {
    const { after, run } = await migrate({ "Channels.vue": source })
    expect(after).toEqual({ "Channels.vue": source.replace("'vite-hub/agent/channels'", "'vite-hub/channels/adapters'") })
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "Channels.vue", line: 2, message: expect.stringContaining("Vue") })])
  })

  it("moves the names that need no Agent to vite-hub/channels and the adapters to vite-hub/channels/adapters", async () => {
    const { after } = await migrate({
      "server/channels/digest.ts": "import { defineChannel } from 'vite-hub/channels'\nimport { defineChannelTrigger, ignored, teams } from 'vite-hub/agent/channels'\nexport default defineChannel({ adapter: teams(), on: { digest: defineChannelTrigger({ invoke: () => ignored('later') }) } })\n",
      "server/channels/answers.ts": "import { retryLater, rejected } from 'vite-hub/agent/channels'\nexport const answers = [retryLater('down'), rejected('bad')]\n",
      "server/channels/mixed.ts": "import { defineChannelTrigger, slack } from 'vite-hub/agent/channels'\nexport const pair = [defineChannelTrigger, slack]\n",
      "server/utils/channels.ts": "export * from 'vite-hub/agent/channels'\nexport type { DiscordAdapterOptions } from 'vite-hub/agent/channels'\n",
      "server/agents/owner.ts": "import { slack } from '@vite-hub/agent/channels'\nexport const channel = slack()\n",
    })
    expect(after).toEqual({
      "server/channels/digest.ts": "import { defineChannel, defineChannelTrigger, ignored } from 'vite-hub/channels'\nimport { teams } from 'vite-hub/channels/adapters'\nexport default defineChannel({ adapter: teams(), on: { digest: defineChannelTrigger({ invoke: () => ignored('later') }) } })\n",
      "server/channels/answers.ts": "import { retryLater, rejected } from 'vite-hub/channels'\nexport const answers = [retryLater('down'), rejected('bad')]\n",
      "server/channels/mixed.ts": "import { slack } from 'vite-hub/channels/adapters'\nimport { defineChannelTrigger } from 'vite-hub/channels'\nexport const pair = [defineChannelTrigger, slack]\n",
      "server/utils/channels.ts": "export * from 'vite-hub/channels/adapters'\nexport type { DiscordAdapterOptions } from 'vite-hub/channels/adapters'\n",
    })
  })

  it("moves webhook() and stripe() from the root of vite-hub/channels to its adapters entry", async () => {
    const { after, run } = await migrate({
      "server/channels/builds.ts": "import { defineChannel, webhook } from 'vite-hub/channels'\nimport { slack } from 'vite-hub/agent/channels'\nexport default defineChannel({ adapter: webhook({ secret: false }) })\nexport const chat = slack()\n",
      "server/channels/payments.ts": "import { stripe } from '@vite-hub/channels'\nimport type { StripeEvent } from '@vite-hub/channels'\nexport const adapter = stripe()\nexport type Event = StripeEvent\n",
      "server/channels/ns.ts": "import * as channels from 'vite-hub/channels'\nexport default channels.defineChannel({ adapter: channels.webhook({ secret: false }) })\n",
    })
    expect(after).toEqual({
      "server/channels/builds.ts": "import { defineChannel } from 'vite-hub/channels'\nimport { webhook } from 'vite-hub/channels/adapters'\nimport { slack } from 'vite-hub/channels/adapters'\nexport default defineChannel({ adapter: webhook({ secret: false }) })\nexport const chat = slack()\n",
      "server/channels/payments.ts": "import { stripe } from '@vite-hub/channels/adapters'\nimport type { StripeEvent } from '@vite-hub/channels/adapters'\nexport const adapter = stripe()\nexport type Event = StripeEvent\n",
    })
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/channels/ns.ts", line: 1, message: expect.stringContaining("vite-hub/channels/adapters") })])
  })
})
