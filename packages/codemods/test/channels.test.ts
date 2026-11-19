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
      "server/channels/team.ts": "import { defineChannel } from 'vite-hub/channels'\nimport { slack } from 'vite-hub/agent/channels'\n\nexport default defineChannel({ adapter: slack() })\n",
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("channels")
    await runCodemod("channels", { cwd, dryRun: false })
    expect(await readFile(join(cwd, "server/channels/team.ts"), "utf8")).toBe("import { defineChannel, slack } from 'vite-hub/channels'\n\nexport default defineChannel({ adapter: slack() })\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("channels")
  })

  it("replaces http() with channelAdapter(\"http\") and moves the path", async () => {
    const { after } = await migrate({
      "server/agents/support.ts": [
        "import { defineAgent } from \"vite-hub/agent\"",
        "import { http, slack } from \"vite-hub/agent/channels\"",
        "",
        "export default defineAgent({",
        "  channels: { portal: http({ route: true }), web: http(), slack: slack() },",
        "})",
        "",
      ].join("\n"),
    })
    expect(after["server/agents/support.ts"]).toBe([
      "import { defineAgent } from \"vite-hub/agent\"",
      "import { channelAdapter, slack } from \"vite-hub/channels\"",
      "",
      "export default defineAgent({",
      "  channels: { portal: channelAdapter(\"http\", { route: true }), web: channelAdapter(\"http\"), slack: slack() },",
      "})",
      "",
    ].join("\n"))
  })

  it("reuses an imported channelAdapter, keeps an alias, and keeps the owner path", async () => {
    const { after } = await migrate({
      "server/agents/a.ts": "import { channelAdapter, http } from '@vite-hub/agent/channels'\nexport const a = [http({ route: true }), channelAdapter('portal')]\n",
      "server/agents/b.ts": "import { http as generic } from '@vite-hub/agent/channels'\nexport const b = generic()\n",
      "server/agents/c.ts": "import { channelAdapter } from 'vite-hub/channels'\nimport { http } from 'vite-hub/agent/channels'\nexport const c = http({ route: true })\n",
    })
    expect(after).toEqual({
      "server/agents/a.ts": "import { channelAdapter } from '@vite-hub/agent/channels'\nexport const a = [channelAdapter('http', { route: true }), channelAdapter('portal')]\n",
      "server/agents/b.ts": "import { channelAdapter as generic } from '@vite-hub/agent/channels'\nexport const b = generic('http')\n",
      "server/agents/c.ts": "import { channelAdapter } from 'vite-hub/channels'\nexport const c = channelAdapter('http', { route: true })\n",
    })
  })

  it("moves re-exports, type imports, and module calls", async () => {
    const { after } = await migrate({
      "server/utils/channels.ts": "export * from 'vite-hub/agent/channels'\nexport { slack } from 'vite-hub/agent/channels'\n",
      "server/agents/types.ts": "import type { DiscordAdapterOptions } from 'vite-hub/agent/channels'\nexport type Options = DiscordAdapterOptions\n",
      "test/channels.test.ts": "vi.mock('vite-hub/agent/channels')\nconst channels = await import('vite-hub/agent/channels')\n",
    })
    expect(after).toEqual({
      "server/utils/channels.ts": "export * from 'vite-hub/channels'\nexport { slack } from 'vite-hub/channels'\n",
      "server/agents/types.ts": "import type { DiscordAdapterOptions } from 'vite-hub/channels'\nexport type Options = DiscordAdapterOptions\n",
      "test/channels.test.ts": "vi.mock('vite-hub/channels')\nconst channels = await import('vite-hub/channels')\n",
    })
  })

  it("reports an http reference that is not a call, and leaves other http names", async () => {
    const { after, run } = await migrate({
      "server/agents/factory.ts": "import { http } from 'vite-hub/agent/channels'\nexport const make = http\n",
      "server/api/ping.ts": "import http from 'node:http'\nexport const server = http.createServer()\n",
    })
    expect(after).toEqual({
      "server/agents/factory.ts": "import { http } from 'vite-hub/channels'\nexport const make = http\n",
    })
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/agents/factory.ts", line: 2, message: expect.stringContaining("channelAdapter(\"http\", options)") })])
  })

  it("moves webhook() and stripe() to secret names and Webhooks signature names", async () => {
    const { after, run } = await migrate({
      "server/channels/prefect.ts": [
        "import { defineChannel, webhook } from 'vite-hub/channels'",
        "export default defineChannel({",
        "  adapter: webhook({ signature: 'github-sha256', secret: process.env.PREFECT_WEBHOOK_SECRET }),",
        "})",
        "",
      ].join("\n"),
      "server/channels/payments.ts": [
        "import { defineChannel, stripe } from '@vite-hub/channels'",
        "export default defineChannel({ adapter: stripe({ secret: useServerEnv().stripe.secret, toleranceSeconds: 600 }) })",
        "",
      ].join("\n"),
      "server/channels/hmac.ts": [
        "import { defineChannel, webhook as hook } from 'vite-hub/channels'",
        "export default defineChannel({ adapter: hook({ signature: { preset: 'hmac-sha256', prefix: 'sha256=' }, header: 'x-sig', secret: 'whsec-123' }) })",
        "export const old = hook({ signature: { preset: 'stripe-sha256', toleranceSeconds: 60 }, secret: () => 'value' })",
        "",
      ].join("\n"),
    })
    expect(after).toEqual({
      "server/channels/prefect.ts": [
        "import { defineChannel, webhook } from 'vite-hub/channels'",
        "export default defineChannel({",
        "  adapter: webhook({ signature: 'github', secret: 'PREFECT_WEBHOOK_SECRET' }),",
        "})",
        "",
      ].join("\n"),
      "server/channels/payments.ts": [
        "import { defineChannel, stripe } from '@vite-hub/channels'",
        "export default defineChannel({ adapter: stripe({ secret: () => useServerEnv().stripe.secret, tolerance: '600s' }) })",
        "",
      ].join("\n"),
      "server/channels/hmac.ts": [
        "import { defineChannel, webhook as hook } from 'vite-hub/channels'",
        "export default defineChannel({ adapter: hook({ signature: { type: 'hmac-sha256', prefix: 'sha256=' }, header: 'x-sig', secret: () => 'whsec-123' }) })",
        "export const old = hook({ signature: { type: 'stripe', tolerance: '60s' }, secret: () => 'value' })",
        "",
      ].join("\n"),
    })
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/channels/hmac.ts", line: 2, message: expect.stringContaining("Move it to a server variable") })])
  })

  it("keeps the new webhook form, and reports a secret it cannot read", async () => {
    const current = "import { defineChannel, webhook } from 'vite-hub/channels'\nexport default defineChannel({ adapter: webhook({ signature: 'github', secret: 'PREFECT_WEBHOOK_SECRET' }) })\n"
    const { after, run } = await migrate({
      "server/channels/prefect.ts": current,
      "server/channels/shared.ts": "import { defineChannel, webhook } from 'vite-hub/channels'\nconst secret = readSecret()\nexport default defineChannel({ adapter: webhook({ signature: 'bearer', secret }) })\n",
    })
    expect(after).toEqual({})
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/channels/shared.ts", line: 3, message: expect.stringContaining("name of the server variable") })])
  })

  it("moves Agent webhook registrations to secret and the Webhooks signature names", async () => {
    const { after, run } = await migrate({
      "server/channels/portal.ts": [
        "import { defineChannel } from 'vite-hub/channels'",
        "import { channelAdapter, defineChannelTrigger } from '@vite-hub/agent/channels'",
        "import { createTelegramAdapter } from '@chat-adapter/telegram'",
        "export default defineChannel({",
        "  adapter: channelAdapter('portal', {",
        "    messages: false,",
        "    adapter: () => createTelegramAdapter({ secretToken: 'adapter-option' }),",
        "    webhooks: [",
        "      { path: '/hooks/github', secretHeader: 'x-hub-signature-256', secretToken: process.env.GITHUB_WEBHOOK_SECRET, signature: 'github-sha256' },",
        "      { path: '/hooks/stripe', secretHeader: 'stripe-signature', secretToken: async () => readSecret(), signature: { preset: 'stripe-sha256', toleranceSeconds: 600 } },",
        "      { path: '/hooks/open', secretToken: false },",
        "    ],",
        "    triggers: {",
        "      digest: defineChannelTrigger({ webhooks: { path: '/hooks/digest', secretToken: 'literal-secret', signature: 'bearer' }, invoke: () => new Response(null) }),",
        "    },",
        "  }),",
        "})",
        "",
      ].join("\n"),
      "server/agents/support.ts": "import { chat } from 'vite-hub/agent/capabilities'\nexport const capability = chat({ webhooks: { telegram: { secretToken: useServerEnv().telegram.webhookSecret } } })\n",
    })
    expect(after["server/channels/portal.ts"]).toBe([
      "import { defineChannel } from 'vite-hub/channels'",
      "import { channelAdapter, defineChannelTrigger } from '@vite-hub/agent/channels'",
      "import { createTelegramAdapter } from '@chat-adapter/telegram'",
      "export default defineChannel({",
      "  adapter: channelAdapter('portal', {",
      "    messages: false,",
      "    adapter: () => createTelegramAdapter({ secretToken: 'adapter-option' }),",
      "    webhooks: [",
      "      { path: '/hooks/github', secretHeader: 'x-hub-signature-256', secret: 'GITHUB_WEBHOOK_SECRET', signature: 'github' },",
      "      { path: '/hooks/stripe', secretHeader: 'stripe-signature', secret: async () => readSecret(), signature: { type: 'stripe', tolerance: '600s' } },",
      "      { path: '/hooks/open', secret: false },",
      "    ],",
      "    triggers: {",
      "      digest: defineChannelTrigger({ webhooks: { path: '/hooks/digest', secretToken: 'literal-secret', signature: 'bearer' }, invoke: () => new Response(null) }),",
      "    },",
      "  }),",
      "})",
      "",
    ].join("\n"))
    expect(after["server/agents/support.ts"]).toBe("import { chat } from 'vite-hub/agent/capabilities'\nexport const capability = chat({ webhooks: { telegram: { secret: () => useServerEnv().telegram.webhookSecret } } })\n")
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/channels/portal.ts", line: 14, message: expect.stringContaining("Move this secret to a server variable") })])
  })
})
