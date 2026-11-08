import { beforeEach, describe, expect, it, vi } from "vitest"

const { createTelegramAdapter, postMessage } = vi.hoisted(() => {
  const postMessage = vi.fn(async () => ({ id: "telegram-1" }))
  return { createTelegramAdapter: vi.fn(() => ({ postMessage })), postMessage }
})
vi.mock("@chat-adapter/telegram", () => ({ createTelegramAdapter }))
vi.mock("#vitehub/env/server", () => ({ useServerEnv: () => ({ telegram: { botToken: "env-token" } }) }))

import { telegram } from "../src/channels.ts"

beforeEach(() => { vi.clearAllMocks() })

describe("telegram() send", () => {
  it.each(["callback", "resolver"])("resolves %s options before sending", async (shape) => {
    const token = vi.fn(async () => ({ unseal: () => "option-token" }))
    const channel = telegram({
      apiBaseUrl: () => "https://telegram.example",
      apiUrl: { resolve: async () => "https://telegram.example/api" },
      botToken: shape === "callback" ? token : { resolve: token },
      userName: () => "option-bot",
    })

    await expect(channel.send("Build finished.", { recipient: "telegram:123" })).resolves.toEqual({ id: "telegram-1" })
    expect(token).toHaveBeenCalledOnce()
    expect(createTelegramAdapter).toHaveBeenCalledWith({
      apiBaseUrl: "https://telegram.example",
      apiUrl: "https://telegram.example/api",
      botToken: "option-token",
      userName: "option-bot",
    })
    expect(postMessage).toHaveBeenCalledWith("telegram:123", { markdown: "Build finished." })
  })
})
