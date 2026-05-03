import { describe, expect, it, vi } from "vitest"

describe("defineChat", () => {
  it("preserves a provided Chat SDK instance", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const bot = { webhooks: {} }
    const context = {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }

    const definition = defineChat({ bot: bot as never })

    expect(await resolveChat(definition, context as never)).toBe(bot)
  })

  it("creates a request-scoped Chat SDK instance", async () => {
    const { defineChat, resolveChat } = await import("../src/index.ts")
    const bot = { webhooks: {} }
    const create = vi.fn(() => bot)
    const context = {
      memo: vi.fn(),
      runtime: "nitro",
      runtimeConfig: { token: "secret" },
      waitUntil: vi.fn(),
    }

    const definition = defineChat({ create: create as never })

    expect(await resolveChat(definition, context as never)).toBe(bot)
    expect(create).toHaveBeenCalledWith(context)
  })

  it("returns raw Chat SDK instances unchanged", async () => {
    const { resolveChat } = await import("../src/index.ts")
    const bot = { webhooks: {} }
    const context = {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }

    expect(await resolveChat(bot as never, context as never)).toBe(bot)
  })
})

describe("runtime context", () => {
  it("memoizes values per context", async () => {
    const { createChatRuntimeContext } = await import("../src/runtime/context.ts")
    const context = createChatRuntimeContext({ runtime: "unknown" })
    const create = vi.fn(() => ({ value: "created" }))

    const first = context.memo("bot", create)
    const second = context.memo("bot", create)

    expect(first).toBe(second)
    expect(create).toHaveBeenCalledTimes(1)
  })
})
