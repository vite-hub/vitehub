import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@libsql/client"
import { createServer, type PluginOption } from "vite"
import { expect, it } from "vitest"

import { runAgentChannelReplayCli } from "../../agent/src/internal/channel-replay-cli.ts"
import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue, agentInvocationStreamRoute } from "../../agent/src/invocation-stream.ts"

it("journals authenticated Vite SSR dry-run replays in the host Console database", async () => {
  // Load the built host integration, as an application does, without typechecking unrelated primitives here.
  const hostEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url))
  const nitroEntry = createRequire(import.meta.url).resolve("nitro/vite")
  const { nitro } = await import(nitroEntry) as { nitro: () => PluginOption }
  const { vitehub } = await import(hostEntry) as { vitehub: (options: Record<string, unknown>) => PluginOption }
  const root = await mkdtemp(join(tmpdir(), "vitehub-replay-console-"))
  const packageRoot = fileURLToPath(new URL("../../agent", import.meta.url))
  const databaseUrl = `file:${join(root, "configured-console.sqlite")}`
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  const client = createClient({ url: databaseUrl })
  try {
    await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
    for (const name of ["agent", "workspace", "blob", "database"]) await symlink(join(packageRoot, "..", name), join(root, "node_modules/@vite-hub", name), "dir")
    await symlink(join(packageRoot, "../vite-hub/node_modules/h3"), join(root, "node_modules/h3"), "dir")
    await symlink(join(packageRoot, "../vite-hub"), join(root, "node_modules/vite-hub"), "dir")
    await mkdir(join(root, "server/agents"), { recursive: true })
    await writeFile(join(root, "server/agents/support.ts"), `
import { defineAgent } from '@vite-hub/agent'
import { defineChannel, defineChannelTrigger } from '@vite-hub/agent/channels'
import { channelDelivery } from '@vite-hub/agent/capabilities'
export default defineAgent({ runtime: false, workspace: { mode: 'read' },
  driver: { async run({ tools, input }) { if (input.context?.skipDelivery) return 'No delivery'; await tools.send_message.execute({ message: 'Synthetic raw draft' }); return 'Synthetic final answer' } },
  capabilities: [channelDelivery({ required: true, channel: { name: 'teams', send: async () => { throw new Error('Connector must never run') } }, options: {} , format: message => 'Formatted: ' + message })],
  channels: { mailbox: defineChannel('mailbox', { messages: false,
    webhooks: { secretHeader: 'x-signature', secretToken: 'secret', signature: 'github-sha256' },
    history: { key: item => item.id, thread: item => item.thread, collection: {
      parseQuery: async query => { if (query.turns !== 'last') throw new Error('Expected turns query'); return query },
      page: async ({ query }) => ({ items: [{ id: query.delivery === 'skip' ? 'm2' : 'm1', thread: 't1' }], nextCursor: null }),
    } },
    triggers: { received: defineChannelTrigger({ invoke: (_context, item) => ({ input: { prompt: item.id, context: { skipDelivery: item.id === 'm2' } }, run: { runId: 'authored', annotations: { authored: 'kept' } } }) }) },
  }) },
})
`)
    await writeFile(join(root, "authorize.ts"), "export default () => ({ actor: { id: 'test', name: 'Test' }, mode: 'admin' })\n")
    server = await createServer({ root, configFile: false, appType: "custom", logLevel: "silent",
      plugins: [vitehub({ preset: "node", agent: true, database: true, workflow: false, env: false, blob: { stores: { default: { driver: "fs", base: join(root, "blob") } } },
        console: { databaseUrl, exposure: "host-managed", authorize: "./authorize.ts" },
      }), nitro()],
      // Initial published SSR-cycle behavior is covered by the separate CLI-discovery PR.
      resolve: { alias: {
        "@vite-hub/agent/server/internal": join(packageRoot, "src/server/internal.ts"),
        "vite-hub/_internal/agent/server/internal": join(packageRoot, "src/server/internal.ts"),
      } },
      server: { port: 0, watch: null, fs: { allow: [root, join(packageRoot, "../..")] } },
    })
    await server.listen()
    const origin = server.resolvedUrls!.local[0]!
    const rejected = await fetch(new URL(agentInvocationStreamRoute, origin), { method: "POST", body: JSON.stringify({ agent: "support", replay: { channel: "mailbox", dryRun: true } }), headers: { [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue, "content-type": "application/json" } })
    expect(rejected.status).toBe(403)
    const discovery = await fetch(new URL(agentInvocationStreamRoute, origin), { headers: { [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue } })
    expect(discovery.status, await discovery.text()).toBe(200)
    const stdout = { write: () => {} }
    const errors: string[] = []
    const code = await runAgentChannelReplayCli(["--server", origin, "--agent", "support", "--channel", "mailbox", "--dry-run", "--label", "native-round", "--query", "turns=last", "--limit", "1"], { env: {}, rootDir: root, stdout, stderr: { write: chunk => errors.push(String(chunk)) } })
    expect(errors).toEqual([])
    expect(code).toBe(0)
    const rows = await client.execute("SELECT status, record FROM vitehub_agent_invocations")
    expect(rows.rows).toHaveLength(1)
    const record = JSON.parse(String(rows.rows[0].record))
    expect(rows.rows[0].status).toBe("completed")
    expect(record.annotations).toMatchObject({ triggeredBy: "native-round", authored: "kept", "vitehub.channel.key": "m1", "vitehub.channel.thread": "t1" })
    // Terminal SQLite records compact their observations into the record column.
    const effects = record.observations.filter((observation: { name: string }) => observation.name === "agent.channel.delivery.effect")
    expect(effects).toHaveLength(1)
    expect(effects[0].attributes).toMatchObject({ "channel.effect.channel": "teams", "channel.effect.skipped": "dry-run", "channel.effect.content": "Synthetic raw draft" })
    const missingDelivery = await runAgentChannelReplayCli(["--server", origin, "--agent", "support", "--channel", "mailbox", "--dry-run", "--label", "missing-delivery", "--query", "turns=last", "--query", "delivery=skip", "--limit", "1"], { env: {}, rootDir: root, stdout, stderr: { write: chunk => errors.push(String(chunk)) } })
    expect(missingDelivery).toBe(1)
    const failed = await client.execute("SELECT status, record FROM vitehub_agent_invocations WHERE status = 'failed'")
    expect(failed.rows).toHaveLength(1)
    expect(JSON.parse(String(failed.rows[0].record)).error).toMatchObject({ code: "CHANNEL_DELIVERY_REQUIRED" })

  } finally { await server?.close(); client.close(); await rm(root, { recursive: true, force: true }) }
}, 60_000)
