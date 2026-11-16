import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { build } from "esbuild"
import { resolveConfig } from "vite"
import { expect, it } from "vitest"
import { hubAgent } from "../src/vite.ts"

it("restores persisted Channel delivery in a fresh worker using only the Node startup registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-node-workflow-state-"))
  const source = resolve(import.meta.dirname, "../src")
  try {
    await symlink(resolve(import.meta.dirname, "../node_modules"), join(root, "node_modules"), "dir")
    await writeFile(join(root, "package.json"), '{"type":"module"}')
    const plugin = hubAgent({ providers: { state: { driver: "libsql", url: `file:${join(root, "agent.sqlite")}` } } })
    await resolveConfig({ root, configFile: false, plugins: [plugin] }, "build")
    const registryFile = join(root, ".vitehub/nitro/workflow/dev-registry.mjs")
    await mkdir(join(root, ".vitehub/nitro/workflow"), { recursive: true })
    const registry = plugin.vitehub?.agent?.transformWorkflowRegistry("export default {}\n", registryFile)
    if (!registry) throw new Error("Expected Agent registry transform")
    await writeFile(registryFile, registry)
    const entry = join(root, "worker.ts")
    await writeFile(entry, `
import assert from 'node:assert/strict'
import ${JSON.stringify(registryFile)}
import { createLibsqlAgentState } from ${JSON.stringify(join(source, "state.ts"))}
import { agentChannelDeliveryWorkflowResolver } from ${JSON.stringify(join(source, "server/routes.ts"))}
import { defineAgent } from ${JSON.stringify(join(source, "index.ts"))}
import { telegram } from ${JSON.stringify(join(source, "channels.ts"))}
const state = createLibsqlAgentState({ url: ${JSON.stringify(`file:${join(root, "agent.sqlite")}`)} })
await state.connect()
const key = 'chat:helper:telegram:deliveries:pending-turn'
if (process.argv[2] === 'admit') {
  await state.set(key, { id: 'pending-turn', agentName: 'helper', channelId: 'telegram', provider: 'telegram', scope: 'thread', sourceId: 'message', status: 'queued', receivedAt: new Date().toISOString() })
} else {
  const agent = defineAgent({ name: 'helper', driver: { run: () => 'done' }, channels: { telegram: telegram({ messages: { durable: true, concurrency: 'parallel', loading: { text: 'Working…' } } }) } })
  const delivery = await agentChannelDeliveryWorkflowResolver(agent, { runtime: 'unknown', agentIdentity: { name: 'helper' }, memo: () => {}, waitUntil: () => {} }, { channelId: 'telegram', deliveryId: 'pending-turn', provider: 'telegram', state: 'chat' })
  assert.equal(delivery?.delivery.id, 'pending-turn')
  assert.equal(delivery.delivery.status, 'queued')
}
await state.disconnect()
process.exit(0)
`)
    const outfile = join(root, "worker.mjs")
    await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", packages: "external" })
    const execute = promisify(execFile)
    await execute(process.execPath, [outfile, "admit"])
    await execute(process.execPath, [outfile, "restore"])
    expect(registry).toContain("setAgentChannelDeliveryWorkflowStateResolver")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
