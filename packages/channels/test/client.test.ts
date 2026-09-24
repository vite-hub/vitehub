import { describe, expect, it, vi } from "vitest"

import { createChannel, defineChannel } from "../src/index.ts"
import { setChannelRuntimeRegistry, useChannel } from "../src/server.ts"

describe("createChannel", () => {
  it("selects the connector through send options and normalizes the result", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const send = vi.fn(async (text: string, recipient: string) => ({ id: `${text}:${recipient}` }))
    const channel = createChannel("alerts", defineChannel({ connectors: { telegram: { send } } }))

    await expect(channel.send("Build finished.", "chat-1", { connector: "telegram" })).resolves.toEqual({
      channel: "alerts",
      connector: "telegram",
      deliveryId: expect.any(String),
      id: "Build finished.:chat-1",
    })
    expect(send).toHaveBeenCalledWith("Build finished.", "chat-1", {})
    info.mockRestore()
  })

  it("uses a configured default connector", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const send = vi.fn(async () => ({ id: "delivery-1" }))
    const channel = createChannel("alerts", defineChannel({
      connectors: { telegram: { send } },
      defaultConnector: "telegram",
    }))

    await expect(channel.send("Build finished.", "chat-1")).resolves.toMatchObject({
      channel: "alerts",
      connector: "telegram",
    })
    info.mockRestore()
  })

  it.each([
    ["", "non-empty"],
    ["Build finished.", "requires a connector"],
  ])("rejects invalid sends", async (text, message) => {
    const channel = createChannel("alerts", { connectors: { telegram: { send: async () => ({ id: "delivery-1" }) } } })
    await expect(channel.send(text, "chat-1")).rejects.toThrow(message)
  })

  it("records failed deliveries without logging message content or connector options", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const channel = createChannel("alerts", defineChannel({
      connectors: { telegram: { send: async () => { throw new Error("provider unavailable") } } },
    }))

    await expect(channel.send("private build output", "chat-1", { connector: "telegram", token: "private-token" } as never)).rejects.toThrow("provider unavailable")
    const logs = info.mock.calls.map(([entry]) => String(entry)).join("\n")
    expect(logs).toContain('"event":"outbound.failed"')
    expect(logs).toContain('"error":"provider unavailable"')
    expect(logs).not.toContain("private build output")
    expect(logs).not.toContain("private-token")
    info.mockRestore()
  })
})

describe("global Agent Channels", () => {
  it("sends through an Agent Channel shared by an extended Agent", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const send = vi.fn(async () => ({ id: "teams-message-1" }))
    const teams = { global: true, send }
    setChannelRuntimeRegistry({
      bot: async () => ({ default: { channels: { teams } } }),
      "bot-dev": async () => ({ default: { channels: { teams } } }),
    })
    try {
      await expect(useChannel("teams").send("Hello", "user:123")).resolves.toMatchObject({
        channel: "teams",
        connector: "teams",
        id: "teams-message-1",
      })
      expect(send).toHaveBeenCalledWith("Hello", "user:123")
    }
    finally {
      setChannelRuntimeRegistry(undefined)
      info.mockRestore()
    }
  })

  it("rejects two different Agent Channels claiming the same global name", async () => {
    setChannelRuntimeRegistry({
      bot: async () => ({ default: { channels: { teams: { global: true, send: async () => ({}) } } } }),
      other: async () => ({ default: { channels: { teams: { global: true, send: async () => ({}) } } } }),
    })
    try {
      await expect(useChannel("teams").send("Hello", "user:123")).rejects.toThrow("more than one Agent")
    }
    finally {
      setChannelRuntimeRegistry(undefined)
    }
  })
})
