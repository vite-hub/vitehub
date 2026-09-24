import { describe, expect, it, vi } from "vitest"

import { createChannel, defineChannel, useChannel } from "../src/index.ts"
import { setChannelRuntimeRegistry } from "../src/runtime/state.ts"

describe("createChannel", () => {
  it("selects the connector through send options and normalizes the result", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const send = vi.fn(async (text: string, options: { chatId: string }) => ({ id: `${text}:${options.chatId}` }))
    const channel = createChannel("alerts", defineChannel({ connectors: { telegram: { send } } }))

    await expect(channel.send("Build finished.", { connector: "telegram", chatId: "chat-1" })).resolves.toEqual([null, {
      channel: "alerts",
      connector: "telegram",
      deliveryId: expect.any(String),
      id: "Build finished.:chat-1",
    }])
    expect(send).toHaveBeenCalledWith("Build finished.", { chatId: "chat-1" })
    info.mockRestore()
  })

  it("uses a configured default connector", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const send = vi.fn(async () => ({ id: "delivery-1" }))
    const channel = createChannel("alerts", defineChannel({
      connectors: { telegram: { send } },
      defaultConnector: "telegram",
    }))

    const [error, receipt] = await channel.send("Build finished.", {} as never)
    expect(error).toBeNull()
    expect(receipt).toMatchObject({
      channel: "alerts",
      connector: "telegram",
    })
    info.mockRestore()
  })

  it.each([
    ["", "non-empty"],
    ["Build finished.", "requires a connector"],
  ])("returns an error for invalid sends", async (text, message) => {
    const channel = createChannel("alerts", { connectors: { telegram: { send: async () => ({ id: "delivery-1" }) } } })
    const [error, receipt] = await channel.send(text, {} as never)
    expect(error?.message).toContain(message)
    expect(receipt).toBeNull()
  })

  it("records failed deliveries without logging message content or connector options", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const channel = createChannel("alerts", defineChannel({
      connectors: { telegram: { send: async () => { throw new Error("provider unavailable") } } },
    }))

    const [error, receipt] = await channel.send("private build output", { connector: "telegram", token: "private-token" } as never)
    expect(error?.message).toBe("provider unavailable")
    expect(receipt).toBeNull()
    const logs = info.mock.calls.map(([entry]) => String(entry)).join("\n")
    expect(logs).toContain('"event":"outbound.failed"')
    expect(logs).toContain('"error":"provider unavailable"')
    expect(logs).not.toContain("private build output")
    expect(logs).not.toContain("private-token")
    info.mockRestore()
  })

  it("returns discovery failures in the tuple", async () => {
    setChannelRuntimeRegistry({})
    try {
      const [error, receipt] = await useChannel("missing" as string).send("Build finished.", { connector: "telegram" })
      expect(error?.message).toContain('No Channel Definition was discovered for "missing"')
      expect(receipt).toBeNull()
    }
    finally {
      setChannelRuntimeRegistry(undefined)
    }
  })

  it("normalizes non-Error connector failures", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      const channel = createChannel("alerts", defineChannel({
        connectors: { telegram: { send: async () => { throw "provider unavailable" } } },
      }))
      const [error, receipt] = await channel.send("Build finished.", { connector: "telegram" })
      expect(error).toBeInstanceOf(Error)
      expect(error?.message).toBe("provider unavailable")
      expect(receipt).toBeNull()
    }
    finally {
      info.mockRestore()
    }
  })
})
