import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "vite"

import { hubSchedule } from "../../schedule/src/vite.ts"
import { hubAgent } from "../src/vite.ts"

interface ScheduledAgentProof {
  deliveries: unknown[]
  runs: unknown[]
}

const proofKey = "__vitehubProcessScheduledAgentProof"

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[proofKey]
  delete process.env.VITEHUB_TEST_SERVICE_PATH
})

describe("Agent Process Schedule integration", () => {
  it("creates and executes an Agent turn through the canonical process registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-process-schedule-"))
    const agentSourceRoot = join(import.meta.dirname, "..", "src")
    const scheduleSourceRoot = join(import.meta.dirname, "..", "..", "schedule", "src")
    const kvSourceRoot = join(import.meta.dirname, "..", "..", "kv", "src")
    const workspaceSourceRoot = join(import.meta.dirname, "..", "..", "workspace", "src")
    const kvConfig = { store: { base: join(root, "kv"), driver: "fs-lite" } }
    const proof: ScheduledAgentProof = { deliveries: [], runs: [] }
    ;(globalThis as Record<string, unknown>)[proofKey] = proof
    process.env.VITEHUB_TEST_SERVICE_PATH = "/srv/mini"
    await mkdir(join(root, "server", "agents"), { recursive: true })
    await writeFile(join(root, "server", "agents", "mini.ts"), [
      "import { defineAgent } from '@vite-hub/agent'",
      "import { kv, schedule } from '@vite-hub/agent/capabilities'",
      "import { defineChannel } from '@vite-hub/agent/channels'",
      "const proof = globalThis.__vitehubProcessScheduledAgentProof",
      "export const chatRoute = {",
      "  mapInput: () => ({",
      "    invokerProfileId: 'discord:user-1',",
      "    run: { channelId: 'discord', origin: 'discord', threadId: 'discord:channel:thread-1' },",
      "  }),",
      "}",
      "export default defineAgent({",
      "  runtime: false,",
      "  capabilities: [kv(), schedule({ allowSelfTarget: true, delivery: 'origin', mode: 'write', timeZone: 'Asia/Bangkok' })],",
      "  channels: {",
      "    discord: defineChannel('discord', {",
      "      adapter: {",
      "        channelIdFromThreadId: (threadId) => threadId,",
      "        postMessage: async (threadId, message) => { proof.deliveries.push({ message, threadId }) },",
      "      },",
      "      route: chatRoute,",
      "    }),",
      "  },",
      "  driver: {",
      "    async run({ context, invoker, prompt, run, runtimeContext, tools, workspace }) {",
      "      if (context.get('schedule')) {",
      "        proof.runs.push({ hasScheduleHandle: Boolean(runtimeContext.capabilities?.schedule), hasWorkspace: Boolean(workspace), invoker, kvValue: await tools.kv_read.execute({ key: 'scheduled-proof' }), prompt, run, servicePath: process.env.VITEHUB_TEST_SERVICE_PATH })",
      "        return { text: `Scheduled ${prompt}` }",
      "      }",
      "      const record = await tools.cronjob.execute({ cron: '0 9 1 1 *', id: 'proof-0900', operation: 'create', prompt: 'Send my daily report.' })",
      "      return { text: `Created ${record.id}` }",
      "    },",
      "  },",
      "  invoker: {",
      "    profiles: [{ id: 'discord:user-1', kind: 'chat', label: 'Maxi' }],",
      "    resolve: ({ defaultInvoker, selectedProfile }) => ({ ...(selectedProfile || defaultInvoker), label: 'Reauthorized Maxi' }),",
      "  },",
      "  workspace: { mode: 'write', store: { provider: 'memory' } },",
      "})",
      "",
    ].join("\n"), "utf8")
    await writeFile(join(root, "schedule-probe.ts"), [
      "export { executeRuntimeSchedule, resetScheduleRuntime, schedules } from '@vite-hub/schedule'",
      "",
    ].join("\n"), "utf8")

    const schedulePlugin = hubSchedule({ providerOutput: false, runtime: { driver: "process", prefix: root } })
    const server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      plugins: [
        schedulePlugin as never,
        hubAgent({
          eval: false,
          providers: { state: { provider: "memory" } },
          routes: { chat: true },
        }),
        {
          name: "@vite-hub/kv/vite",
          resolveId(id) {
            if (id === "#vitehub/kv/config") return "\0test-kv-config"
            if (id === "nitro") return "\0test-nitro-runtime"
            if (id === "h3") return "\0test-h3-runtime"
          },
          load(id) {
            if (id === "\0test-kv-config") return `export const kv = ${JSON.stringify(kvConfig)}`
            if (id === "\0test-nitro-runtime") return "export const definePlugin = plugin => plugin"
            if (id === "\0test-h3-runtime") {
              return [
                "export const createError = input => Object.assign(new Error(input.statusMessage), input)",
                "export const defineEventHandler = handler => handler",
                "export const getRequestHeaders = event => event.headers || {}",
                "export const getRequestURL = event => new URL(event.url)",
                "export const getRouterParam = (event, name) => event.params?.[name]",
                "export const readRawBody = async event => event.body",
              ].join("\n")
            }
          },
        },
      ],
      resolve: {
        alias: [
          { find: /^@vite-hub\/agent$/, replacement: join(agentSourceRoot, "index.ts") },
          { find: /^@vite-hub\/agent\/capabilities$/, replacement: join(agentSourceRoot, "capabilities.ts") },
          { find: /^@vite-hub\/agent\/channels$/, replacement: join(agentSourceRoot, "channels.ts") },
          { find: /^@vite-hub\/agent\/runtime\/workflow$/, replacement: join(agentSourceRoot, "runtime", "workflow.ts") },
          { find: /^@vite-hub\/agent\/server\/internal$/, replacement: join(agentSourceRoot, "server", "internal.ts") },
          { find: /^@vite-hub\/schedule$/, replacement: join(scheduleSourceRoot, "index.ts") },
          { find: /^@vite-hub\/schedule\/runtime$/, replacement: join(scheduleSourceRoot, "runtime.ts") },
          { find: /^@vite-hub\/schedule\/runtime\/driver$/, replacement: join(scheduleSourceRoot, "runtime", "driver.ts") },
          { find: /^@vite-hub\/schedule\/runtime\/process$/, replacement: join(scheduleSourceRoot, "runtime", "process.ts") },
          { find: /^@vite-hub\/kv$/, replacement: join(kvSourceRoot, "index.ts") },
          { find: /^@vite-hub\/workspace\/runtime$/, replacement: join(workspaceSourceRoot, "runtime.ts") },
        ],
      },
      root,
      server: { middlewareMode: true },
    })
    const closeHandlers: Array<() => Promise<void> | void> = []
    const requestHandlers: Array<() => Promise<void> | void> = []
    let scheduleProbe: {
      executeRuntimeSchedule: (options: { id: string, scheduledAt: Date }) => Promise<unknown>
      resetScheduleRuntime: () => void
      schedules: { get: (id: string) => Promise<unknown> }
    } | undefined
    try {
      const pluginSource = await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")

      const routeSource = await readFile(join(root, ".vitehub", "agent", "chat-webhook-route.ts"), "utf8")
      expect(routeSource).toContain('import vitehubAgentScheduleRegistry from "#vitehub/schedule/registry"')
      expect(routeSource).toContain("vitehubSetScheduleRuntimeRegistry(vitehubAgentScheduleRegistry)")
      expect(routeSource).toContain("capabilities: vitehubAgentRouteCapabilities")
      expect(routeSource).toContain('import { kv as vitehubKv } from "@vite-hub/kv"')
      expect(routeSource).toContain("const vitehubAgentRouteCapabilities = { kv: vitehubKv, schedule: { schedules: vitehubSchedules } }")
      const runtimePlugin = await server.ssrLoadModule(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"))
      const route = await server.ssrLoadModule(join(root, ".vitehub", "agent", "chat-webhook-route.ts"))
      const nitroApp = {
        captureError(error: unknown) {
          throw error
        },
        async fetch(request: Request) {
          return await route.default({
            body: await request.text(),
            headers: Object.fromEntries(request.headers),
            method: request.method,
            params: { agent: "mini" },
            url: request.url,
          })
        },
        hooks: {
          hook(name: string, handler: () => Promise<void> | void) {
            if (name === "close") closeHandlers.push(handler)
            if (name === "request") requestHandlers.push(handler)
          },
        },
      }
      await runtimePlugin.default(nitroApp)
      for (const request of requestHandlers) await request()
      expect(pluginSource).toMatch(/nitroApp\.(?:fetch = async \((?:request|\.\.\.args)\) =>|hooks\.hook\('request')/)
      expect(pluginSource).not.toContain("h3App")
      const response = await nitroApp.fetch(new Request("https://example.com/api/_vitehub/agents/mini/chat", {
        body: JSON.stringify({
          id: "thread-1",
          messages: [{
            id: "user-1",
            parts: [{ text: "Create my daily report.", type: "text" }],
            role: "user",
          }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }))
      const responseText = await response.text()
      expect({ responseText, status: response.status }).toEqual({
        responseText: expect.stringContaining("Created proof-0900"),
        status: 200,
      })

      scheduleProbe = await server.ssrLoadModule(join(root, "schedule-probe.ts")) as typeof scheduleProbe
      await expect(scheduleProbe!.schedules.get("proof-0900")).resolves.toMatchObject({
        id: "proof-0900",
        target: "agent/mini",
        timeZone: "Asia/Bangkok",
      })
      const run = await scheduleProbe!.executeRuntimeSchedule({
        id: "proof-0900",
        scheduledAt: new Date("2026-01-01T02:00:00.000Z"),
      })
      expect(run).toMatchObject({ scheduleId: "proof-0900", status: "succeeded", target: "agent/mini" })
      expect(proof.runs).toEqual([{
        hasScheduleHandle: true,
        hasWorkspace: true,
        invoker: { id: "discord:user-1", kind: "chat", label: "Reauthorized Maxi" },
        kvValue: null,
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
      for (const close of closeHandlers) await close()
      scheduleProbe?.resetScheduleRuntime()
      await server.close()
      await rm(root, { force: true, recursive: true })
    }
  }, 15_000)
})
