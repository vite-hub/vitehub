import { describe, expect, it, vi } from "vitest"

import { ask } from "../src/ask.ts"
import { askJev } from "../src/internal/ask-runtime.ts"

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
