import { describe, expect, it, vi } from "vitest"

import { ask } from "../src/ask.ts"
import { askJev } from "../src/internal/ask-runtime.ts"
import { hubAgent } from "../src/vite.ts"

vi.mock("advocaat", () => {
  throw new Error("Cannot find package 'advocaat'")
})

describe("ask Driver without advocaat", () => {
  it("explains how to install the optional peer", async () => {
    await expect(askJev({}, "Win money", { spam: ask.if("Is it spam?") })).rejects.toMatchObject({
      code: "AGENT_R0928",
      message: "[vitehub] TypeSafe Jev requests require the advocaat package. Install it with: pnpm add advocaat",
    })
  })
})

describe("Agent Vite plugin", () => {
  it("keeps advocaat external only when the application does not install it", async () => {
    // SAFETY: The test calls the hook with the only plugin context member it uses.
    const resolveId = hubAgent().resolveId as (...args: unknown[]) => Promise<unknown>
    const installed = { external: false, id: "/app/node_modules/advocaat/dist/index.mjs" }

    await expect(resolveId.call({ resolve: async () => null }, "advocaat", "/agent.js", {})).resolves.toEqual({ external: true, id: "advocaat" })
    await expect(resolveId.call({ resolve: async () => installed }, "advocaat", "/agent.js", {})).resolves.toBe(installed)
    await expect(resolveId.call({ resolve: async () => null }, "ai", "/agent.js", {})).resolves.toBeUndefined()
  })
})
