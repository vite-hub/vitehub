import { describe, expect, it, vi } from "vitest"

import { createChannel, defineChannel } from "../src/index.ts"

describe("createChannel", () => {
  it("selects the connector through send options and normalizes the result", async () => {
    const send = vi.fn(async (text: string, options: { chatId: string }) => ({ id: `${text}:${options.chatId}` }))
    const channel = createChannel("alerts", defineChannel({ connectors: { telegram: { send } } }))

    await expect(channel.send("Build finished.", { connector: "telegram", chatId: "chat-1" })).resolves.toEqual({
      channel: "alerts",
      connector: "telegram",
      id: "Build finished.:chat-1",
    })
    expect(send).toHaveBeenCalledWith("Build finished.", { chatId: "chat-1" })
  })

  it("uses a configured default connector", async () => {
    const send = vi.fn(async () => ({ id: "delivery-1" }))
    const channel = createChannel("alerts", defineChannel({
      connectors: { telegram: { send } },
      defaultConnector: "telegram",
    }))

    await expect(channel.send("Build finished.", {} as never)).resolves.toMatchObject({
      channel: "alerts",
      connector: "telegram",
    })
  })

  it("resolves Env-backed definitions for every send", async () => {
    let token = "first-token"
    const resolve = vi.fn(() => token)
    const channel = createChannel("alerts", defineChannel(({ env }) => ({
      connectors: {
        fixture: {
          send: async (_text: string, options: { recipient: string }) => ({ id: `${env.token}:${options.recipient}` }),
        },
      },
    })), () => ({ token: resolve() }))

    await expect(channel.send("Build finished.", { connector: "fixture", recipient: "one" })).resolves.toMatchObject({
      id: "first-token:one",
    })
    token = "second-token"
    await expect(channel.send("Build finished.", { connector: "fixture", recipient: "two" })).resolves.toMatchObject({
      id: "second-token:two",
    })
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["", "non-empty"],
    ["Build finished.", "requires a connector"],
  ])("rejects invalid sends", async (text, message) => {
    const channel = createChannel("alerts", { connectors: { telegram: { send: async () => ({ id: "delivery-1" }) } } })
    await expect(channel.send(text, {} as never)).rejects.toThrow(message)
  })
})
