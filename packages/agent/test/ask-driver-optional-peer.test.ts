import { describe, expect, it, vi } from "vitest"
import { fileURLToPath } from "node:url"

import { ask } from "@vite-hub/gateways"
import { askJev } from "../src/internal/ask-runtime.ts"
import { hubAgent } from "../src/vite.ts"

vi.mock("advocaat", () => {
  throw new Error("Cannot find package 'advocaat'")
})

describe("ask Driver without advocaat", () => {
  it("explains how to install the optional peer", async () => {
    await expect(askJev({}, "Win money", { spam: ask.if("Is it spam?") })).rejects.toMatchObject({
      code: "GATEWAYS_R0006",
      message: "[vitehub] TypeSafe Jev requests require the advocaat package. Install it with: pnpm add advocaat",
    })
  })
})

describe("Agent Vite plugin", () => {
  it("keeps advocaat external only when the application does not install it", async () => {
    // SAFETY: The test calls the hook with the only plugin context member it uses.
    const resolveId = (hubAgent().resolveId as { handler: (...args: unknown[]) => Promise<unknown> }).handler
    const installed = { external: false, id: "/app/node_modules/advocaat/dist/index.mjs" }

    const agentImporter = "/app/node_modules/@vite-hub/agent/dist/internal/ask-runtime.js"
    await expect(resolveId.call({ resolve: async () => null }, "advocaat", agentImporter, {})).resolves.toEqual({ external: true, id: "advocaat" })
    await expect(resolveId.call({ resolve: async () => installed }, "advocaat", agentImporter, {})).resolves.toBe(installed)
    await expect(resolveId.call({ resolve: async () => null }, "advocaat", "/app/src/main.ts", {})).resolves.toBeUndefined()
    await expect(resolveId.call({ resolve: async () => null }, "advocaat", "/app/packages/agent/index.ts", {})).resolves.toBeUndefined()
    await expect(resolveId.call({ resolve: async () => null }, "advocaat", undefined, {})).resolves.toBeUndefined()
    await expect(resolveId.call({ resolve: async () => null }, "advocaat", fileURLToPath(new URL("../src/internal/ask-runtime.ts", import.meta.url)), {})).resolves.toEqual({ external: true, id: "advocaat" })
    await expect(resolveId.call({ resolve: async () => null }, "advocaat", "C:\\app\\node_modules\\@vite-hub\\agent\\dist\\index.js", {})).resolves.toEqual({ external: true, id: "advocaat" })
    await expect(resolveId.call({ resolve: async () => null }, "ai", "/agent.js", {})).resolves.toBeUndefined()
  })

  it("filters resolveId and transform to the ids the plugin handles", () => {
    const plugin = hubAgent()
    const resolveFilter = (plugin.resolveId as { filter: { id: RegExp } }).filter.id
    const transformFilter = (plugin.transform as { filter: { id: RegExp } }).filter.id

    expect(["advocaat", "@vite-hub/kv", "@ai-sdk/openai", "ai", "@vite-hub/kv/vite", "advocaat/sub", "@ai-sdk/openai/internal"].map(id => resolveFilter.test(id))).toEqual([true, true, true, false, false, false, false])
    expect([
      "/app/server/agents/reviewer.ts",
      "/app/server/agents/reviewer.MTS?v=1",
      "/app/.vitehub/workflow/registry-runtime.mjs",
      "/app/server/api/route.js#hash",
      "/app/src/app.vue",
      "/app/src/style.css",
      "\0virtual:vitehub-agent",
    ].map(id => transformFilter.test(id))).toEqual([true, true, true, true, false, false, false])
  })
})
