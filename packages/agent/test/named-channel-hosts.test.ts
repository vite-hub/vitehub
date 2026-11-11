import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { build } from "esbuild"
import { resolveConfig } from "vite"
import { expect, it, vi } from "vitest"
import { hubAgent } from "../src/vite.ts"

it.each(["deno", "netlify"] as const)("serves listed Channel registration paths in %s output", async (hosting) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-named-channel-host-"))
  const packageRoot = resolve(import.meta.dirname, "..")
  try {
    if (hosting === "netlify") vi.stubEnv("VITEHUB_HOST", "netlify")
    await cp(join(packageRoot, "node_modules"), join(root, "node_modules"), { recursive: true })
    await symlink(packageRoot, join(root, "node_modules/@vite-hub/agent"), "dir")
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "named-channel-host", type: "module" }))
    await mkdir(join(root, "server/agents"), { recursive: true })
    await mkdir(join(root, "server/channels"), { recursive: true })
    await mkdir(join(root, ".vitehub/schedule"), { recursive: true })
    await writeFile(join(root, ".vitehub/schedule/deno-cron.mjs"), "export {}")
    await writeFile(join(root, "server/channels/hooks.ts"), [
      "import { defineChannel, webhook } from '@vite-hub/channels'",
      "import { defineChannelTrigger } from '@vite-hub/agent/channels'",
      "import other from '../agents/other'",
      "export default defineChannel({",
      "  adapter: webhook({ signature: 'bearer', secret: 'secret', path: '/hooks', aliases: ['/old-hooks'] }),",
      "  on: { webhook: defineChannelTrigger({ invoke: context => Response.json({ agent: context.agentName, channel: context.trigger.channelId, other: other.description }) }) },",
      "})",
    ].join("\n"))
    await writeFile(join(root, "server/channels/custom.ts"), [
      "import { defineChannel } from '@vite-hub/channels'",
      "import { channelAdapter as customAdapter, defineChannelTrigger } from '@vite-hub/agent/channels'",
      "const registration = { path: '/custom', aliases: ['/old-custom'], secretToken: 'secret', secretHeader: 'authorization', signature: 'bearer' }",
      "export default defineChannel({ adapter: customAdapter('custom', {",
      "  messages: false, webhooks: [registration, { ...registration, path: '/custom-two', aliases: [] }],",
      "  triggers: { webhook: defineChannelTrigger({ invoke: context => Response.json({ agent: context.agentName, channel: context.trigger.channelId }) }) },",
      "}) })",
    ].join("\n"))
    await writeFile(join(root, "server/channels/chat.ts"), [
      "import { defineChannel } from '@vite-hub/channels'",
      "import * as channels from '@vite-hub/agent/channels'",
      "export default defineChannel({ adapter: channels.teams({ webhooks: { path: '/chat', aliases: ['/old-chat'] } }) })",
    ].join("\n"))
    await writeFile(join(root, "server/channels/tasks.ts"), [
      "import { defineChannel, webhook } from '@vite-hub/channels'",
      "import { defineChannelTrigger } from '@vite-hub/agent/channels'",
      "export default defineChannel({ adapter: webhook({ signature: 'bearer', secret: 'secret', path: '/task-hooks' }), on: { webhook: defineChannelTrigger({",
      "  tasks: { reply: { agent: () => import('../agents/support'), prepare: context => Response.json({ agent: context.agentName, channel: context.trigger.channelId }) } },",
      "  invoke: () => ({ task: 'reply', input: { prompt: 'reply' } }),",
      "}) } })",
    ].join("\n"))
    await writeFile(join(root, "server/agents/support.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "export default defineAgent({ name: 'support', channels: ['hooks', 'custom', 'chat', 'tasks'], runtime: false, driver: { run: () => 'ok' } })",
    ].join("\n"))
    // A second Agent proves that aliases select the owner without an Agent route parameter.
    await writeFile(join(root, "server/agents/other.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "export default defineAgent({ description: 'Other Agent', runtime: false, driver: { run: () => 'other' } })",
    ].join("\n"))
    const plugin = hubAgent({ runtime: hosting === "deno" ? "deno" : undefined, providers: { state: { driver: "memory" } } })
    if (typeof plugin.config !== "function") throw new Error("Expected config hook")
    await plugin.config.call({} as never, { root }, { command: "build", mode: "production" })
    const config = await resolveConfig({ root, configFile: false, build: { outDir: "dist" } }, "build")
    await (plugin.configResolved as (config: unknown) => Promise<void>)(config)
    let output: string
    if (hosting === "netlify") {
      await (plugin.buildEnd as () => Promise<void>)()
      await rm(join(root, "server"), { recursive: true })
      await (plugin.closeBundle as { handler: () => Promise<void> }).handler()
      output = join(root, ".netlify/v1/functions/vitehub-agent.mjs")
      const source = await readFile(output, "utf8")
      for (const path of ["/api/_vitehub/channels/hooks", "/hooks", "/old-hooks", "/custom", "/old-custom", "/custom-two", "/chat", "/old-chat"]) expect(source).toContain(JSON.stringify(path))
    }
    else {
      await rm(join(root, "server"), { recursive: true })
      output = join(root, "deno-server.mjs")
      await build({
        entryPoints: [join(root, ".vitehub/agent/deno-server.ts")], outfile: output,
        bundle: true, platform: "node", format: "esm", packages: "external", tsconfigRaw: { compilerOptions: {} },
        plugins: [{ name: "generated-agent-registry", setup(builder) {
          builder.onResolve({ filter: /^#vitehub\/agent\/registry$/ }, () => ({ path: join(root, ".vitehub/agent/registry.mjs") }))
        } }],
      })
    }
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", [
      "let handler",
      "globalThis.Deno = { args: [], serve: callback => { handler = callback; return { finished: Promise.resolve() } } }",
      "const module = await import(process.argv[1])",
      "handler ||= module.default",
      "for (const path of ['/api/_vitehub/channels/hooks', '/hooks', '/old-hooks', '/api/_vitehub/agents/support/webhooks/hooks', '/custom', '/old-custom', '/custom-two', '/task-hooks']) {",
      "  const context = { params: path.startsWith('/api/_vitehub/agents/') ? { agent: 'support', webhook: 'hooks' } : {} }",
      "  const denied = await handler(new Request('https://example.com' + path, { method: 'POST', body: '{}' }), context)",
      "  if (denied.status !== 401) throw new Error('Expected signature verification for ' + path + ', received ' + denied.status)",
      "  const response = await handler(new Request('https://example.com' + path, { method: 'POST', body: '{}', headers: { authorization: 'Bearer secret' } }), context)",
      "  console.log('delivery:' + JSON.stringify({ path, status: response.status, body: await response.json() }))",
      "}",
      "for (const path of ['/chat', '/old-chat']) {",
      "  const response = await handler(new Request('https://example.com' + path, { method: 'HEAD' }), { params: {} })",
      "  if (response.status !== 204) throw new Error('Missing chat adapter route: ' + path + ', received ' + response.status)",
      "}",
    ].join("\n"), pathToFileURL(output).href])
    const deliveries = stdout.trim().split("\n").filter(line => line.startsWith("delivery:")).map(line => JSON.parse(line.slice("delivery:".length)))
    expect(deliveries).toHaveLength(8)
    for (const delivered of deliveries) {
      expect(delivered).toMatchObject({ status: 200, body: { agent: "support", channel: delivered.path.includes("custom") ? "custom" : delivered.path === "/task-hooks" ? "tasks" : "hooks" } })
      if (delivered.body.channel === "hooks") expect(delivered.body.other).toBe("Other Agent")
    }
  }
  finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
