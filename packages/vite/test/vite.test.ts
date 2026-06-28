import { describe, expect, it, vi } from "vitest"

const queueMocks = vi.hoisted(() => ({
  hubQueue: vi.fn(() => ({ name: "@vite-hub/queue/vite" })),
}))

vi.mock("@vite-hub/agent", () => ({ defineAgent: "define-agent" }))
vi.mock("@vite-hub/agent/capabilities", () => ({ workspaceShell: "workspace-shell" }))
vi.mock("@vite-hub/agent/channels", () => ({ stream: "stream-channel" }))
vi.mock("@vite-hub/agent/vite", () => ({ hubAgent: () => ({ name: "@vite-hub/agent/vite" }) }))
vi.mock("@vite-hub/blob/vite", () => ({ hubBlob: () => ({ name: "@vite-hub/blob/vite" }) }))
vi.mock("@vite-hub/database/vite", () => ({ hubDb: () => ({ name: "@vite-hub/database/vite" }) }))
vi.mock("@vite-hub/devtools", () => ({ hubDevtools: () => ({ name: "@vite-hub/devtools" }) }))
vi.mock("@vite-hub/env/vite", () => ({ env: "env-helper", hubEnv: () => ({ name: "@vite-hub/env/vite" }) }))
vi.mock("@vite-hub/kv/vite", () => ({ hubKv: () => ({ name: "@vite-hub/kv/vite" }) }))
vi.mock("@vite-hub/queue", () => ({ defineQueue: "define-queue" }))
vi.mock("@vite-hub/queue/vite", () => ({ hubQueue: queueMocks.hubQueue }))
vi.mock("@vite-hub/sandbox/vite", () => ({ hubSandbox: () => ({ name: "@vite-hub/sandbox/vite" }) }))
vi.mock("@vite-hub/schedule/vite", () => ({ hubSchedule: () => ({ name: "@vite-hub/schedule/vite" }) }))
vi.mock("@vite-hub/workflow/vite", () => ({ hubWorkflow: () => ({ name: "@vite-hub/workflow/vite" }) }))
vi.mock("@vite-hub/workspace/vite", () => ({ hubWorkspace: () => ({ name: "@vite-hub/workspace/vite" }) }))

import type { Plugin, PluginOption } from "vite"
import * as agent from "../src/agent.ts"
import * as capabilities from "../src/agent/capabilities.ts"
import * as channels from "../src/agent/channels.ts"
import { env, vitehub } from "../src/index.ts"
import * as queue from "../src/queue.ts"

function pluginNames(plugins: PluginOption[]): string[] {
  return plugins.map(plugin => (plugin as Plugin).name)
}

describe("vitehub", () => {
  it("composes ViteHub primitive integrations explicitly", () => {
    expect(pluginNames(vitehub())).toEqual([
      "@vite-hub/vite/facade-alias",
      "@vite-hub/env/vite",
      "@vite-hub/agent/vite",
      "@vite-hub/database/vite",
      "@vite-hub/blob/vite",
      "@vite-hub/kv/vite",
      "@vite-hub/sandbox/vite",
      "@vite-hub/schedule/vite",
      "@vite-hub/workflow/vite",
      "@vite-hub/workspace/vite",
      "@vite-hub/devtools",
    ])
    expect(pluginNames(vitehub({ database: false, devtools: false, kv: false }))).toEqual([
      "@vite-hub/vite/facade-alias",
      "@vite-hub/env/vite",
      "@vite-hub/agent/vite",
      "@vite-hub/blob/vite",
      "@vite-hub/sandbox/vite",
      "@vite-hub/schedule/vite",
      "@vite-hub/workflow/vite",
      "@vite-hub/workspace/vite",
    ])
    queueMocks.hubQueue.mockClear()
    expect(pluginNames(vitehub({ queue: true }))).toContain("@vite-hub/queue/vite")
    expect(queueMocks.hubQueue).toHaveBeenLastCalledWith({})
    expect(pluginNames(vitehub({ queue: { provider: "cloudflare" } }))).toContain("@vite-hub/queue/vite")
    expect(queueMocks.hubQueue).toHaveBeenLastCalledWith({ provider: "cloudflare" })
  })

  it("resolves public ViteHub imports through the facade", async () => {
    const plugin = vitehub()[0] as Plugin
    const resolveId = plugin.resolveId as unknown as (this: { resolve: (id: string) => Promise<string> }, id: string, importer?: string, options?: object) => Promise<string | undefined>
    const context = {
      async resolve(id: string) {
        return `resolved:${id}`
      },
    }

    await expect(resolveId.call(context, "@vite-hub/agent/eval", "/app/server/agents/support.eval.ts")).resolves.toBe("resolved:@vite-hub/vite/agent/eval")
    await expect(resolveId.call(context, "@vite-hub/agent/server/internal", "/app/.vitehub/agent/route.mjs")).resolves.toBe("resolved:@vite-hub/vite/agent/server/internal")
    await expect(resolveId.call(context, "@vite-hub/blob/drivers/s3", "/app/src/blob.ts")).resolves.toBe("resolved:@vite-hub/vite/blob/drivers/s3")
    await expect(resolveId.call(context, "@vite-hub/database", "/app/src/db.ts")).resolves.toBe("resolved:@vite-hub/vite/database")
    await expect(resolveId.call(context, "@vite-hub/database/drizzle", "/app/src/db.ts")).resolves.toBe("resolved:@vite-hub/vite/database/drizzle")
    await expect(resolveId.call(context, "@vite-hub/queue", "/app/src/welcome.queue.ts")).resolves.toBe("resolved:@vite-hub/vite/queue")
    await expect(resolveId.call(context, "@vite-hub/workspace/internal/runtime/state", "/app/src/server.ts")).resolves.toBeUndefined()
    await expect(resolveId.call(context, "@vite-hub/agent", "/app/node_modules/@vite-hub/vite/dist/agent.js")).resolves.toBeUndefined()

    const configEnvironment = plugin.configEnvironment as (name: string, config: { consumer?: string, resolve?: { noExternal?: unknown } }) => unknown
    expect(configEnvironment("ssr", { consumer: "server" })).toEqual({
      resolve: { noExternal: ["@vite-hub/vite"] },
    })
    expect(configEnvironment("ssr", { consumer: "server", resolve: { noExternal: ["existing"] } })).toEqual({
      resolve: { noExternal: ["existing", "@vite-hub/vite"] },
    })
  })

  it("can be used as one nested Vite plugin entry", () => {
    const plugins: PluginOption[] = [vitehub()]
    expect(plugins).toHaveLength(1)
  })

  it("re-exports the env declaration helper for Vite config", () => {
    expect(env).toBe("env-helper")
  })

  it("forwards the Agent Definition import surface", () => {
    expect(agent.defineAgent).toBe("define-agent")
    expect(capabilities.workspaceShell).toBe("workspace-shell")
    expect(channels.stream).toBe("stream-channel")
  })

  it("forwards the Queue primitive import surface", () => {
    expect(queue.defineQueue).toBe("define-queue")
  })
})
