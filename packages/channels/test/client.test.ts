import { describe, expect, it, vi } from "vitest"

import { createChannel, defineOutboundChannel, useChannel } from "../src/index.ts"
import { setChannelRuntimeRegistry } from "../src/runtime/state.ts"

describe("createChannel", () => {
  it("preserves connector option instances and their private state", async () => {
    class Destination {
      #id = "room-1"

      getId() {
        return this.#id
      }
    }
    const options = Object.assign(new Destination(), { connector: "configured" as const })
    const send = vi.fn((_text: string, options: Destination) => ({ id: options.getId() }))
    const channel = createChannel("instances", { connectors: { configured: { send } } })

    await expect(channel.send("message", options)).resolves.toMatchObject([null, { id: "room-1" }])
    expect(send.mock.calls[0]?.[1]).toBe(options)
  })

  it("preserves array connector options", async () => {
    const options = Object.assign(["room-1", "room-2"], { connector: "configured" as const })
    const send = vi.fn((_text: string, options: string[]) => ({ id: options.join(",") }))
    const channel = createChannel("arrays", { connectors: { configured: { send } } })

    await expect(channel.send("message", options)).resolves.toMatchObject([null, { id: "room-1,room-2" }])
    expect(send.mock.calls[0]?.[1]).toBe(options)
  })

  it("selects the connector through send options and normalizes the result", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const send = vi.fn(async (text: string, options: { chatId: string }) => ({ id: `${text}:${options.chatId}` }))
    const channel = createChannel("alerts", defineOutboundChannel({ connectors: { telegram: { send } } }))

    await expect(channel.send("Build finished.", { connector: "telegram", chatId: "chat-1" })).resolves.toEqual([null, {
      channel: "alerts",
      connector: "telegram",
      deliveryId: expect.any(String),
      id: "Build finished.:chat-1",
    }])
    expect(send).toHaveBeenCalledWith("Build finished.", { connector: "telegram", chatId: "chat-1" })
    info.mockRestore()
  })

  it("uses a configured default connector", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const send = vi.fn(async () => ({ id: "delivery-1" }))
    const channel = createChannel("alerts", defineOutboundChannel({
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

  it("rejects inherited connectors before dispatch", async () => {
    const inheritedSend = vi.fn(() => ({ id: "unexpected" }))
    const connectors = { configured: { send: vi.fn(() => ({})) } }
    Object.setPrototypeOf(connectors, { inherited: { send: inheritedSend } })
    const channel = createChannel("alerts", { connectors })

    const [error, receipt] = await channel.send("Build finished.", { connector: "inherited" } as never)
    expect(error?.message).toContain('does not define connector "inherited"')
    expect(receipt).toBeNull()
    expect(inheritedSend).not.toHaveBeenCalled()
  })

  it.each(["", null, false, 0, { toString: () => "configured" }])("rejects invalid connector selectors without using the default: %j", async (connector) => {
    const send = vi.fn(() => ({}))
    const channel = createChannel("alerts", {
      connectors: { configured: { send } },
      defaultConnector: "configured",
    })

    const [error, receipt] = await channel.send("Build finished.", { connector } as never)
    expect(error).toBeInstanceOf(Error)
    expect(receipt).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it.each(["started", "completed"])("preserves successful delivery when %s logging throws", async (event) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => { throw new Error("log unavailable") })
    if (event === "completed") info.mockImplementationOnce(() => {})
    const send = vi.fn(() => ({ id: "delivered" }))
    try {
      const channel = createChannel("alerts", { connectors: { configured: { send } } })
      await expect(channel.send("Build finished.", { connector: "configured" })).resolves.toMatchObject([null, { id: "delivered" }])
      expect(send).toHaveBeenCalledOnce()
    }
    finally {
      info.mockRestore()
    }
  })

  it.each([false, true])("preserves delivery fields when the message id is inaccessible, enumerable=%s", async (enumerable) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const readId = vi.fn(() => { throw new Error("message id is unavailable") })
    const extension = Symbol("connector extension")
    const raw = { accepted: true }
    const result = Object.defineProperty({
      [extension]: "preserved",
      providerStatus: "accepted",
      raw,
      get providerMetadata() { return this.raw },
    }, "id", { enumerable, get: readId })
    const send = vi.fn(() => result)
    try {
      const channel = createChannel("alerts", { connectors: { configured: { send } } })
      const [error, receipt] = await channel.send("Build finished.", { connector: "configured" })

      expect(error).toBeNull()
      expect(receipt).toMatchObject({
        [extension]: "preserved",
        channel: "alerts",
        connector: "configured",
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
      const channel = createChannel("alerts", { connectors: { configured: { send: () => result } } })
      const [error, receipt] = await channel.send("Build finished.", { connector: "configured" })

      expect(error).toBeNull()
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
      const channel = createChannel("alerts", { connectors: { configured: { send } } })
      const [error, receipt] = await channel.send("Build finished.", { connector: "configured" })

      expect(error).toBeNull()
      expect(receipt).toMatchObject({ id: "delivered", channel: "alerts", connector: "configured" })
      if (failure !== "enumeration") expect(receipt).toHaveProperty("providerStatus", "accepted")
      expect(receipt).not.toHaveProperty("raw")
      expect(send).toHaveBeenCalledOnce()
      expect(info.mock.calls.flat().join("\n")).not.toContain("outbound.failed")
    }
    finally {
      info.mockRestore()
    }
  })

  it.each([123, null, false, {}, ["provider-id"], new String("provider-id")].map(id => ({ id })))("omits a non-string connector ID without retrying delivery: $id", async ({ id }) => {
    const send = vi.fn(() => ({ id, status: "accepted" }))
    const channel = createChannel("alerts", defineOutboundChannel({ connectors: { webhook: { send } } }))

    const [error, receipt] = await channel.send("Build finished.", { connector: "webhook" })

    expect(error).toBeNull()
    expect(receipt).toMatchObject({ channel: "alerts", connector: "webhook", status: "accepted" })
    expect(receipt).not.toHaveProperty("id")
    expect(send).toHaveBeenCalledOnce()
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
    const channel = createChannel("alerts", defineOutboundChannel({
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

  it.each([
    ["throwing", { get: () => { throw new Error("cannot read message") } }],
    ["non-string", { value: 42 }],
  ])("returns the original error when its message is %s", async (_label, descriptor) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const failure = Object.defineProperty(new Error(), "message", descriptor)
    try {
      const channel = createChannel("alerts", defineOutboundChannel({
        connectors: { telegram: { send: async () => { throw failure } } },
      }))
      const [error, receipt] = await channel.send("Build finished.", { connector: "telegram" })
      expect(error).toBe(failure)
      expect(receipt).toBeNull()
      expect(info).toHaveBeenLastCalledWith(expect.stringContaining('"error":"Channel send failed with an uninspectable value."'))
    }
    finally {
      info.mockRestore()
    }
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

  it("does not load inherited registry entries", async () => {
    const load = vi.fn(async () => ({ connectors: { configured: { send: () => ({}) } } }))
    const registry = {}
    Object.setPrototypeOf(registry, { inherited: load })
    setChannelRuntimeRegistry(registry)
    try {
      const [error, receipt] = await useChannel("inherited" as string).send("Build finished.", { connector: "configured" })
      expect(error?.message).toContain('No Channel Definition was discovered for "inherited"')
      expect(receipt).toBeNull()
      expect(load).not.toHaveBeenCalled()
    }
    finally {
      setChannelRuntimeRegistry(undefined)
    }
  })

  it("rejects inherited channel definition markers", async () => {
    const send = vi.fn(() => ({ id: "inherited" }))
    const inherited = {
      default: { connectors: { configured: { send } } },
    }
    setChannelRuntimeRegistry({
      inherited: async () => Object.create(inherited),
    })
    try {
      const [error, receipt] = await useChannel("inherited" as string).send("Build finished.", { connector: "configured" })
      expect(error?.message).toContain('No Channel Definition was discovered for "inherited"')
      expect(receipt).toBeNull()
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
      .mockResolvedValue({ connectors: { configured: { send } } })
    setChannelRuntimeRegistry({ alerts: load })
    try {
      const channel = useChannel("alerts" as string)
      await expect(channel.send("Build finished.", { connector: "configured" })).resolves.toMatchObject([expect.any(Error), null])
      await expect(channel.send("Build finished.", { connector: "configured" })).resolves.toMatchObject([null, { id: "delivered" }])
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
    const load = vi.fn(async () => ({ connectors: { configured: { send } } }));
    setChannelRuntimeRegistry({ alerts: load });
    try {
      const first = useChannel("alerts" as string);
      const second = useChannel("alerts" as string);
      const results = await Promise.all([first.send("First", { connector: "configured" }), second.send("Second", { connector: "configured" })]);
      expect(results.every(([error]) => error === null)).toBe(true);
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
    setChannelRuntimeRegistry({ alerts: async () => ({ connectors: { configured: { send: first } } }) });
    const channel = useChannel("alerts" as string);
    try {
      await expect(channel.send("First", { connector: "configured" })).resolves.toMatchObject([null, { id: "old" }]);
      setChannelRuntimeRegistry({ alerts: async () => ({ connectors: { configured: { send: second } } }) });
      await expect(channel.send("Second", { connector: "configured" })).resolves.toMatchObject([null, { id: "new" }]);
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
    const pending = channel.send("First", { connector: "configured" });
    const load = vi.fn(async () => ({ connectors: { configured: { send: () => ({ id: "new" }) } } }));
    setChannelRuntimeRegistry({ alerts: load });
    try {
      await expect(channel.send("Second", { connector: "configured" })).resolves.toMatchObject([null, { id: "new" }]);
      fail(new Error("old registry failed"));
      await expect(pending).resolves.toMatchObject([expect.any(Error), null]);
      await expect(channel.send("Third", { connector: "configured" })).resolves.toMatchObject([null, { id: "new" }]);
      expect(load).toHaveBeenCalledOnce();
    } finally {
      setChannelRuntimeRegistry(undefined);
      info.mockRestore();
    }
  });

  it("normalizes non-Error connector failures", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      const channel = createChannel("alerts", defineOutboundChannel({
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

  it("returns a tuple even when the thrown value cannot be inspected", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    try {
      const channel = createChannel("alerts", defineOutboundChannel({
        connectors: { telegram: { send: async () => { throw proxy } } },
      }))
      const [error, receipt] = await channel.send("Build finished.", { connector: "telegram" })
      expect(error?.message).toBe("Channel send failed with an uninspectable value.")
      expect(receipt).toBeNull()
    }
    finally {
      info.mockRestore()
    }
  })
})
