import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "vite"

import {
  createMemoryRuntimeScheduleStore,
  createMemoryScheduleRunStore,
  executeRuntimeSchedule,
  resetScheduleRuntime,
  schedules,
} from "../../schedule/src/index.ts"
import { installScheduleRuntime } from "../../schedule/src/runtime/driver.ts"
import { hubSchedule } from "../../schedule/src/vite.ts"
import { hubAgent } from "../src/vite.ts"

interface ScheduledAgentProof {
  deliveries: unknown[]
  runs: unknown[]
}

const proofKey = "__vitehubProcessScheduledAgentProof"

afterEach(() => {
  resetScheduleRuntime()
  delete (globalThis as Record<string, unknown>)[proofKey]
  delete process.env.VITEHUB_TEST_SERVICE_PATH
})

describe("Agent Process Schedule integration", () => {
  it("creates and executes an Agent turn through the canonical process registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-process-schedule-"))
    const agentSourceRoot = join(import.meta.dirname, "..", "src")
    const proof: ScheduledAgentProof = { deliveries: [], runs: [] }
    ;(globalThis as Record<string, unknown>)[proofKey] = proof
    process.env.VITEHUB_TEST_SERVICE_PATH = "/srv/mini"
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "mini.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "import { schedule } from '@vite-hub/agent/capabilities'",
      "import { defineChannel } from '@vite-hub/agent/channels'",
      "const proof = globalThis.__vitehubProcessScheduledAgentProof",
      "export default defineAgent({",
      "  capabilities: [schedule({ allowSelfTarget: true, delivery: 'origin', mode: 'write' })],",
      "  channels: {",
      "    discord: defineChannel('discord', {",
      "      adapter: {",
      "        channelIdFromThreadId: (threadId) => threadId,",
      "        postMessage: async (threadId, message) => { proof.deliveries.push({ message, threadId }) },",
      "      },",
      "    }),",
      "  },",
      "  driver: {",
      "    run({ invoker, prompt, run, workspace }) {",
      "      proof.runs.push({ hasWorkspace: Boolean(workspace), invoker, prompt, run, servicePath: process.env.VITEHUB_TEST_SERVICE_PATH })",
      "      return { text: `Scheduled ${prompt}` }",
      "    },",
      "  },",
      "  invoker: { resolve: ({ defaultInvoker }) => ({ ...defaultInvoker, label: 'Reauthorized Maxi' }) },",
      "  workspace: { mode: 'write', store: { provider: 'memory' } },",
      "})",
      "",
    ].join("\n"), "utf8")

    const schedulePlugin = hubSchedule({ providerOutput: false, runtime: { driver: "process" } })
    const server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      plugins: [
        schedulePlugin as never,
        hubAgent({ eval: false, routes: { chat: false, discordGateway: false, webhooks: false } }),
      ],
      resolve: {
        alias: [
          { find: /^@vite-hub\/agent$/, replacement: join(agentSourceRoot, "index.ts") },
          { find: /^@vite-hub\/agent\/capabilities$/, replacement: join(agentSourceRoot, "capabilities.ts") },
          { find: /^@vite-hub\/agent\/channels$/, replacement: join(agentSourceRoot, "channels.ts") },
          { find: /^@vite-hub\/agent\/server\/internal$/, replacement: join(agentSourceRoot, "server", "internal.ts") },
        ],
      },
      root,
      server: { middlewareMode: true },
    })
    let controller: Awaited<ReturnType<typeof installScheduleRuntime>> | undefined
    try {
      const pluginSource = await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
      expect(pluginSource).toContain('runtimeScheduleRegistry from "#vitehub/schedule/registry"')
      const registryModule = await server.ssrLoadModule("#vitehub/schedule/registry")
      const registry = registryModule.default
      expect(registry).toHaveProperty("agent/mini")

      controller = await installScheduleRuntime({
        createDriver: () => ({ reconcile: async () => {} }),
        registry,
        runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
        scheduleRunStore: createMemoryScheduleRunStore(),
      })
      await expect(schedules.create({
        cron: "0 9 * * *",
        id: "daily-0900",
        input: {
          delivery: { channelId: "discord", origin: "discord", threadId: "discord:channel:thread-1" },
          invoker: { id: "discord:user-1", kind: "chat", label: "Maxi" },
          kind: "agent-turn",
          prompt: "Send my daily report.",
        },
        target: "agent/mini",
        timeZone: "Asia/Bangkok",
      })).resolves.toMatchObject({ id: "daily-0900", target: "agent/mini" })

      const run = await executeRuntimeSchedule({
        id: "daily-0900",
        scheduledAt: new Date("2026-07-12T02:00:00.000Z"),
      })
      expect(run).toMatchObject({ scheduleId: "daily-0900", status: "succeeded", target: "agent/mini" })
      expect(proof.runs).toEqual([{
        hasWorkspace: true,
        invoker: { id: "discord:user-1", kind: "chat", label: "Reauthorized Maxi" },
        prompt: "Send my daily report.",
        run: expect.objectContaining({
          channelId: "discord",
          origin: "discord",
          threadId: "discord:channel:thread-1",
        }),
        servicePath: "/srv/mini",
      }])
      expect(proof.deliveries).toEqual([{
        message: { markdown: "Scheduled Send my daily report." },
        threadId: "discord:channel:thread-1",
      }])
    }
    finally {
      await controller?.close()
      await server.close()
      await rm(root, { force: true, recursive: true })
    }
  }, 15_000)
})
