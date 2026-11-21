import { once } from "node:events"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { resolveConfig } from "vite"
import { expect, it, vi } from "vitest"
import { agentRuntimeModule, hubAgent } from "../src/vite.ts"

vi.mock(import("@vite-hub/internal/build/deployment-output"), async (importOriginal) => {
  const original = await importOriginal()
  const { contributeProviderDeploymentOutput } = original
  return {
    ...original,
    contributeProviderDeploymentOutput: (...[catalog, contribution, generation]: Parameters<typeof contributeProviderDeploymentOutput>) => {
      contributeProviderDeploymentOutput(catalog, {
        ...contribution,
        write: context => contribution.write({
          ...context,
          write: options => context.write({
            ...options,
            netlify: options.netlify && {
              ...options.netlify,
              functions: options.netlify.functions?.map(func => ({
                ...func,
                bundleOptions: {
                  ...func.bundleOptions,
                  packages: "external",
                  external: [...func.bundleOptions.external ?? [], agentRuntimeModule("server/internal")],
                },
              })),
            },
          }),
        }),
      }, generation)
    },
  }
})

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
      "import { defineChannel } from '@vite-hub/channels'\nimport { webhook } from '@vite-hub/channels/adapters'",
      "import { defineChannelTrigger } from '@vite-hub/agent/channels'",
      "import other from '../agents/other'",
      "export default defineChannel({",
      "  adapter: webhook({ signature: 'bearer', secret: () => 'secret', path: '/hooks', aliases: ['/old-hooks'] }),",
      "  on: { webhook: defineChannelTrigger({ invoke: context => Response.json({ agent: context.agentName, channel: context.trigger.channelId, other: other.description }) }) },",
      "})",
    ].join("\n"))
    await writeFile(join(root, "server/channels/custom.ts"), [
      "import { defineChannel } from '@vite-hub/channels'",
      "import { channelAdapter as customAdapter, defineChannelTrigger } from '@vite-hub/agent/channels'",
      "const registration = { path: '/custom', aliases: ['/old-custom'], secret: () => 'secret', secretHeader: 'authorization', signature: 'bearer' }",
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
      "import { defineChannel } from '@vite-hub/channels'\nimport { webhook } from '@vite-hub/channels/adapters'",
      "import { defineChannelTrigger } from '@vite-hub/agent/channels'",
      "export default defineChannel({ adapter: webhook({ signature: 'bearer', secret: () => 'secret', path: '/task-hooks' }), on: { webhook: defineChannelTrigger({",
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
      for (const path of ["/_vitehub/channels/hooks", "/hooks", "/old-hooks", "/custom", "/old-custom", "/custom-two", "/chat", "/old-chat"]) expect(source).toContain(JSON.stringify(path))
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
    const runner = join(root, "check-routes.mjs")
    await writeFile(runner, [
      "import { parentPort, workerData } from 'node:worker_threads'",
      "let handler",
      "globalThis.Deno = { args: [], serve: callback => { handler = callback; return { finished: Promise.resolve() } } }",
      "const module = await import(workerData)",
      "handler ||= module.default",
      "const deliveries = []",
      "for (const path of ['/_vitehub/channels/hooks', '/hooks', '/old-hooks', '/_vitehub/agents/support/webhooks/hooks', '/custom', '/old-custom', '/custom-two', '/task-hooks']) {",
      "  const context = { params: path.startsWith('/_vitehub/agents/') ? { agent: 'support', webhook: 'hooks' } : {} }",
      "  const denied = await handler(new Request('https://example.com' + path, { method: 'POST', body: '{}' }), context)",
      "  if (denied.status !== 401) throw new Error('Expected signature verification for ' + path + ', received ' + denied.status)",
      "  const response = await handler(new Request('https://example.com' + path, { method: 'POST', body: '{}', headers: { authorization: 'Bearer secret' } }), context)",
      "  deliveries.push({ path, status: response.status, body: await response.json() })",
      "}",
      "for (const path of ['/chat', '/old-chat']) {",
      "  const response = await handler(new Request('https://example.com' + path, { method: 'HEAD' }), { params: {} })",
      "  if (response.status !== 204) throw new Error('Missing chat adapter route: ' + path + ', received ' + response.status)",
      "}",
      "parentPort.postMessage(deliveries)",
    ].join("\n"))
    const worker = new Worker(runner, { workerData: pathToFileURL(output).href })
    const [deliveries] = await Promise.race([
      once(worker, "message"),
      once(worker, "exit").then(([code]) => { throw new Error(`Channel host Worker exited before reporting deliveries (${code}).`) }),
    ]).finally(() => worker.terminate())
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
