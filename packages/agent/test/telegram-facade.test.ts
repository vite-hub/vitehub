import { describe, expect, it } from "vitest"

describe("telegram chat adapter facade", () => {
  it("creates a Telegram adapter from static options", async () => {
    const { telegram } = await import("../src/chat/telegram.ts")
    const adapter = await telegram({ botToken: "123:test" })({} as never)

    expect(adapter).toMatchObject({ name: "telegram" })
  })

  it("resolves Telegram adapter options from callback context", async () => {
    const { telegram } = await import("../src/chat/telegram.ts")
    const adapter = await telegram(() => ({ botToken: "123:test", userName: "audio_bot" }))({} as never)

    expect(adapter).toMatchObject({ name: "telegram" })
  })
})
