import { runInNewContext } from "node:vm"

import { describe, expect, it, vi } from "vitest"

import { createChannel, defineChannel, useChannel } from "../src/index.ts"
import { setChannelRuntimeRegistry } from "../src/runtime/state.ts"

describe("createChannel", () => {
  it("preserves provider errors from another realm", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const failure = runInNewContext("Object.assign(new Error('provider unavailable'), { code: 'RATE_LIMIT', cause: new Error('quota reached') })")
    expect(failure).not.toBeInstanceOf(Error)
    try {
      const channel = createChannel("alerts", {
        adapter: { kind: "configured", send: async () => { throw failure } },
      })

      const [error, receipt] = await channel.send("Build finished.")
      expect(error?.code).toBe("CHANNEL_SEND_FAILED")
      expect(error?.cause).toBe(failure)
      expect(receipt).toBeUndefined()
      expect(info).toHaveBeenLastCalledWith(expect.stringContaining('"error":"provider unavailable"'))
    }
    finally {
      info.mockRestore()
    }
  })

  it("wraps objects that spoof the Error brand", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const failure = { message: "spoofed", [Symbol.toStringTag]: "Error" }
    try {
      const channel = createChannel("alerts", {
        adapter: { kind: "configured", send: async () => { throw failure } },
      })

      const [error, receipt] = await channel.send("Build finished.")
      expect(error?.cause).toBeInstanceOf(Error)
      expect(error?.cause).not.toBe(failure)
      expect(receipt).toBeUndefined()
    }
    finally {
      info.mockRestore()
    }
  })

  it("rejects spoofed errors when native Error branding is unavailable", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    class SpoofedError {
      message = "spoofed"
    }
    const failure = new SpoofedError()
    Object.defineProperty(failure, Symbol.toStringTag, { configurable: true, value: "Error" })
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    try {
      const channel = createChannel("alerts", {
        adapter: { kind: "configured", send: async () => { throw failure } },
      })

      const [error, receipt] = await channel.send("Build finished.")
      expect(error?.cause).toBeInstanceOf(Error)
      expect(error?.cause).not.toBe(failure)
      expect(receipt).toBeUndefined()
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
      else Reflect.deleteProperty(Error, "isError")
      info.mockRestore()
    }
  })

  it("passes options with a length property to the adapter", async () => {
    const send = vi.fn((_text: string, _options: { destination: string, length: number } | readonly string[]) => ({ id: "accepted" }))
    const channel = createChannel("union", { adapter: { kind: "configured", send } })
    const options = { destination: "room", length: 1 }
    await expect(channel.send("message", options)).resolves.toMatchObject([undefined, { id: "accepted" }])
    expect(send).toHaveBeenCalledWith("message", options)
  })

  it("preserves send option instances and their private state", async () => {
    class Destination {
      #id = "room-1"

      getId() {
        return this.#id
      }
    }
    const options = new Destination()
    const send = vi.fn((_text: string, options: Destination) => ({ id: options.getId() }))
    const channel = createChannel("instances", { adapter: { kind: "configured", send } })

    await expect(channel.send("message", options)).resolves.toMatchObject([undefined, { id: "room-1" }])
    expect(send.mock.calls[0]?.[1]).toBe(options)
  })

  it("sends through the adapter and normalizes the result", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const send = vi.fn(async (text: string, options: { chatId: string }) => ({ id: `${text}:${options.chatId}` }))
    const channel = createChannel("alerts", defineChannel({ adapter: { kind: "telegram", send } }))

    await expect(channel.send("Build finished.", { chatId: "chat-1" })).resolves.toEqual([undefined, {
      channel: "alerts",
      deliveryId: expect.any(String),
      id: "Build finished.:chat-1",
    }])
    expect(send).toHaveBeenCalledWith("Build finished.", { chatId: "chat-1" })
    info.mockRestore()
  })

  it.each([[], "text", 1])("rejects send options that are not an object: %j", async (options) => {
    const send = vi.fn(() => ({}))
    const channel = createChannel("alerts", { adapter: { kind: "configured", send } })

    const [error, receipt] = await channel.send("Build finished.", options as never)
    expect(error?.code).toBe("CHANNEL_INVALID_SEND")
    expect(receipt).toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })

  it("returns CHANNEL_INVALID_SEND for an adapter that only receives", async () => {
    const channel = createChannel("payments", { adapter: { kind: "stripe" } })

    const [error, receipt] = await channel.send("Build finished.")
    expect(error).toMatchObject({ code: "CHANNEL_INVALID_SEND", why: 'Channel "payments" cannot send: its "stripe" adapter only receives messages.' })
    expect(receipt).toBeUndefined()
  })

  it.each(["started", "completed"])("preserves successful delivery when %s logging throws", async (event) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => { throw new Error("log unavailable") })
    if (event === "completed") info.mockImplementationOnce(() => {})
    const send = vi.fn(() => ({ id: "delivered" }))
    try {
      const channel = createChannel("alerts", { adapter: { kind: "configured", send } })
      await expect(channel.send("Build finished.")).resolves.toMatchObject([undefined, { id: "delivered" }])
      expect(send).toHaveBeenCalledOnce()
    }
    finally {
      info.mockRestore()
    }
  })

  it.each([false, true])("preserves delivery fields when the message id is inaccessible, enumerable=%s", async (enumerable) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const readId = vi.fn(() => { throw new Error("message id is unavailable") })
    const extension = Symbol("adapter extension")
    const raw = { accepted: true }
    const result = Object.defineProperty({
      [extension]: "preserved",
      providerStatus: "accepted",
      raw,
      get providerMetadata() { return this.raw },
    }, "id", { enumerable, get: readId })
    const send = vi.fn(() => result)
    try {
      const channel = createChannel("alerts", { adapter: { kind: "configured", send } })
      const [error, receipt] = await channel.send("Build finished.")

      expect(error).toBeUndefined()
      expect(receipt).toMatchObject({
        [extension]: "preserved",
        channel: "alerts",
        providerMetadata: raw,
        providerStatus: "accepted",
        raw,
      })
      expect(receipt?.raw).toBe(raw)
      expect(receipt).not.toHaveProperty("id")
      expect(send).toHaveBeenCalledOnce()
      expect(readId).toHaveBeenCalledOnce()
      expect(info.mock.calls.flat().join("\n")).not.toContain("outbound.failed")
    }
    finally {
      info.mockRestore()
    }
  })

  it("reads optional message ids once for both the receipt and delivery log", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const readId = vi.fn()
      .mockReturnValueOnce("delivered")
      .mockImplementation(() => { throw new Error("message id was read again") })
    const result = Object.defineProperty({ raw: { accepted: true } }, "id", { enumerable: true, get: readId })
    try {
      const channel = createChannel("alerts", { adapter: { kind: "configured", send: () => result } })
      const [error, receipt] = await channel.send("Build finished.")

      expect(error).toBeUndefined()
      expect(receipt).toMatchObject({ id: "delivered", raw: { accepted: true } })
      expect(readId).toHaveBeenCalledOnce()
      expect(info.mock.calls.flat().join("\n")).toContain('"messageId":"delivered"')
    }
    finally {
      info.mockRestore()
    }
  })

  it.each(["getter", "descriptor", "enumeration"])("preserves delivery when optional metadata %s throws", async (failure) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const metadata = {
      id: "delivered",
      providerStatus: "accepted",
      get raw() { throw new Error("metadata unavailable") },
    }
    const result = new Proxy(metadata, {
      ownKeys(target) {
        if (failure === "enumeration") throw new Error("cannot enumerate metadata")
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, key) {
        if (failure === "descriptor" && key === "raw") throw new Error("cannot inspect metadata")
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    const send = vi.fn(() => result)
    try {
      const channel = createChannel("alerts", { adapter: { kind: "configured", send } })
      const [error, receipt] = await channel.send("Build finished.")

      expect(error).toBeUndefined()
      expect(receipt).toMatchObject({ id: "delivered", channel: "alerts" })
      if (failure !== "enumeration") expect(receipt).toHaveProperty("providerStatus", "accepted")
      expect(receipt).not.toHaveProperty("raw")
      expect(send).toHaveBeenCalledOnce()
      expect(info.mock.calls.flat().join("\n")).not.toContain("outbound.failed")
    }
    finally {
      info.mockRestore()
    }
  })

  it.each([123, null, false, {}, ["provider-id"], new String("provider-id")].map(id => ({ id })))("omits a non-string message ID without retrying delivery: $id", async ({ id }) => {
    const send = vi.fn(() => ({ id, status: "accepted" }))
    const channel = createChannel("alerts", defineChannel({ adapter: { kind: "webhook", send: send as never } }))

    const [error, receipt] = await channel.send("Build finished.")

    expect(error).toBeUndefined()
    expect(receipt).toMatchObject({ channel: "alerts", status: "accepted" })
    expect(receipt).not.toHaveProperty("id")
    expect(send).toHaveBeenCalledOnce()
  })

  it("returns an error for empty text", async () => {
    const channel = createChannel("alerts", { adapter: { kind: "telegram", send: async () => ({ id: "delivery-1" }) } })
    const [error, receipt] = await channel.send("")
    expect(error?.message).toContain("non-empty")
    expect(receipt).toBeUndefined()
  })

  it("passes an object message to the adapter as is", async () => {
    const send = vi.fn(async (_message: { card: { type: "card" }, fallbackText: string }) => ({ id: "card-1" }))
    const channel = createChannel("alerts", { adapter: { kind: "teams", send } })
    const message = { card: { type: "card" as const }, fallbackText: "Build finished" }

    const [error, receipt] = await channel.send(message)

    expect(error).toBeUndefined()
    expect(receipt).toMatchObject({ channel: "alerts", id: "card-1" })
    expect(send.mock.calls[0]?.[0]).toBe(message)
  })

  it.each([" ", null, ["Build finished."], 42].map(message => ({ message })))("returns an error for a message that is not text or an object: $message", async ({ message }) => {
    const send = vi.fn(async () => ({ id: "delivery-1" }))
    const channel = createChannel("alerts", { adapter: { kind: "telegram", send } })
    const [error, receipt] = await channel.send(message as never)
    expect(error).toMatchObject({ code: "CHANNEL_INVALID_SEND" })
    expect(receipt).toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })

  it("records failed deliveries without logging message content or send options", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const channel = createChannel("alerts", defineChannel({
      adapter: { kind: "telegram", send: async () => { throw new Error("provider unavailable") } },
    }))

    const [error, receipt] = await channel.send("private build output", { token: "private-token" } as never)
    expect(error).toMatchObject({
      code: "CHANNEL_SEND_FAILED",
      docs: "https://vitehub.dev/docs/channels/diagnostics/channel_send_failed",
      why: 'The "telegram" adapter of Channel "alerts" failed to send the message.',
    })
    expect(error?.cause).toHaveProperty("message", "provider unavailable")
    expect(receipt).toBeUndefined()
    const logs = info.mock.calls.map(([entry]) => String(entry)).join("\n")
    expect(logs).toContain('"event":"outbound.failed"')
    expect(logs).toContain('"error":"provider unavailable"')
    expect(logs).not.toContain("private build output")
    expect(logs).not.toContain("private-token")
    info.mockRestore()
  })

  it.each([
    ["throwing", { get: () => { throw new Error("cannot read message") } }],
    ["non-string", { value: 42 }],
  ])("returns the original error when its message is %s", async (_label, descriptor) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const failure = Object.defineProperty(new Error(), "message", descriptor)
    try {
      const channel = createChannel("alerts", defineChannel({
        adapter: { kind: "telegram", send: async () => { throw failure } },
      }))
      const [error, receipt] = await channel.send("Build finished.")
      expect(error?.code).toBe("CHANNEL_SEND_FAILED")
      expect(error?.cause).toBe(failure)
      expect(receipt).toBeUndefined()
      expect(info).toHaveBeenLastCalledWith(expect.stringContaining('"error":"Channel send failed with an uninspectable value."'))
    }
    finally {
      info.mockRestore()
    }
  })

  it("returns discovery failures in the tuple", async () => {
    setChannelRuntimeRegistry({})
    try {
      const [error, receipt] = await useChannel("missing" as string).send("Build finished.")
      expect(error?.code).toBe("CHANNEL_DEFINITION_FAILED")
      expect(error?.cause).toHaveProperty("message", expect.stringContaining('No Channel Definition was discovered for "missing"'))
      expect(receipt).toBeUndefined()
    }
    finally {
      setChannelRuntimeRegistry(undefined)
    }
  })

  it.each(["direct", "module"])("normalizes raw Channel options from a %s registry entry", async (shape) => {
    const send = vi.fn(() => ({ id: "raw-1" }))
    const options = { adapter: { kind: "configured", send } }
    setChannelRuntimeRegistry({ alerts: async () => shape === "direct" ? options : { default: options } })
    try {
      const [error, receipt] = await useChannel("alerts" as string).send("Build finished.")
      expect(error).toBeUndefined()
      expect(receipt).toMatchObject({ id: "raw-1", channel: "alerts" })
      expect(send).toHaveBeenCalledWith("Build finished.", {})
    }
    finally {
      setChannelRuntimeRegistry(undefined)
    }
  })

  it("does not load inherited registry entries", async () => {
    const load = vi.fn(async () => ({ adapter: { kind: "configured", send: () => ({}) } }))
    const registry = {}
    Object.setPrototypeOf(registry, { inherited: load })
    setChannelRuntimeRegistry(registry)
    try {
      const [error, receipt] = await useChannel("inherited" as string).send("Build finished.")
      expect(error?.code).toBe("CHANNEL_DEFINITION_FAILED")
      expect(error?.cause).toHaveProperty("message", expect.stringContaining('No Channel Definition was discovered for "inherited"'))
      expect(receipt).toBeUndefined()
      expect(load).not.toHaveBeenCalled()
    }
    finally {
      setChannelRuntimeRegistry(undefined)
    }
  })

  it("rejects inherited channel definition markers", async () => {
    const send = vi.fn(() => ({ id: "inherited" }))
    const inherited = {
      default: defineChannel({ adapter: { kind: "configured", send } }),
    }
    setChannelRuntimeRegistry({
      inherited: async () => Object.create(inherited),
    })
    try {
      const [error, receipt] = await useChannel("inherited" as string).send("Build finished.")
      expect(error?.code).toBe("CHANNEL_DEFINITION_FAILED")
      expect(error?.cause).toHaveProperty("message", expect.stringContaining('No Channel Definition was discovered for "inherited"'))
      expect(receipt).toBeUndefined()
      expect(send).not.toHaveBeenCalled()
    }
    finally {
      setChannelRuntimeRegistry(undefined)
    }
  })

  it("retries failed discovery on a later send", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const send = vi.fn(() => ({ id: "delivered" }))
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("temporary loader failure"))
      .mockResolvedValue(defineChannel({ adapter: { kind: "configured", send } }))
    setChannelRuntimeRegistry({ alerts: load })
    try {
      const channel = useChannel("alerts" as string)
      await expect(channel.send("Build finished.")).resolves.toMatchObject([expect.objectContaining({ code: "CHANNEL_DEFINITION_FAILED" }), undefined])
      await expect(channel.send("Build finished.")).resolves.toMatchObject([undefined, { id: "delivered" }])
      expect(load).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenCalledOnce()
    }
    finally {
      setChannelRuntimeRegistry(undefined)
      info.mockRestore()
    }
  })

  it("shares definition loading across named clients and concurrent sends", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const send = vi.fn(() => ({ id: "delivered" }));
    const load = vi.fn(async () => defineChannel({ adapter: { kind: "configured", send } }));
    setChannelRuntimeRegistry({ alerts: load });
    try {
      const first = useChannel("alerts" as string);
      const second = useChannel("alerts" as string);
      const results = await Promise.all([first.send("First"), second.send("Second")]);
      expect(results.every(([error]) => error === undefined)).toBe(true);
      expect(load).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      setChannelRuntimeRegistry(undefined);
      info.mockRestore();
    }
  });

  it("refreshes existing named clients when their registry changes", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const first = vi.fn(() => ({ id: "old" }));
    const second = vi.fn(() => ({ id: "new" }));
    setChannelRuntimeRegistry({ alerts: async () => defineChannel({ adapter: { kind: "configured", send: first } }) });
    const channel = useChannel("alerts" as string);
    try {
      await expect(channel.send("First")).resolves.toMatchObject([undefined, { id: "old" }]);
      setChannelRuntimeRegistry({ alerts: async () => defineChannel({ adapter: { kind: "configured", send: second } }) });
      await expect(channel.send("Second")).resolves.toMatchObject([undefined, { id: "new" }]);
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
    } finally {
      setChannelRuntimeRegistry(undefined);
      info.mockRestore();
    }
  });

  it("keeps an old failed load from evicting the replacement registry client", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let fail!: (error: Error) => void;
    const old = new Promise<never>((_resolve, reject) => { fail = reject; });
    setChannelRuntimeRegistry({ alerts: () => old });
    const channel = useChannel("alerts" as string);
    const pending = channel.send("First");
    const load = vi.fn(async () => defineChannel({ adapter: { kind: "configured", send: () => ({ id: "new" }) } }));
    setChannelRuntimeRegistry({ alerts: load });
    try {
      await expect(channel.send("Second")).resolves.toMatchObject([undefined, { id: "new" }]);
      fail(new Error("old registry failed"));
      await expect(pending).resolves.toMatchObject([expect.objectContaining({ code: "CHANNEL_DEFINITION_FAILED" }), undefined]);
      await expect(channel.send("Third")).resolves.toMatchObject([undefined, { id: "new" }]);
      expect(load).toHaveBeenCalledOnce();
    } finally {
      setChannelRuntimeRegistry(undefined);
      info.mockRestore();
    }
  });

  it("normalizes non-Error adapter failures", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      const channel = createChannel("alerts", defineChannel({
        adapter: { kind: "telegram", send: async () => { throw "provider unavailable" } },
      }))
      const [error, receipt] = await channel.send("Build finished.")
      expect(error?.cause).toBeInstanceOf(Error)
      expect(error?.cause).toHaveProperty("message", "provider unavailable")
      expect(receipt).toBeUndefined()
    }
    finally {
      info.mockRestore()
    }
  })

  it("returns a tuple even when the thrown value cannot be inspected", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    try {
      const channel = createChannel("alerts", defineChannel({
        adapter: { kind: "telegram", send: async () => { throw proxy } },
      }))
      const [error, receipt] = await channel.send("Build finished.")
      expect(error?.cause).toHaveProperty("message", "Channel send failed with an uninspectable value.")
      expect(receipt).toBeUndefined()
    }
    finally {
      info.mockRestore()
    }
  })
})
