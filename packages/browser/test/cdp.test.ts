import { setImmediate } from "node:timers/promises"

import { describe, expect, it, vi } from "vitest"

import { cdp } from "../src/controllers/cdp.ts"
import { createBrowser } from "../src/index.ts"

class FakeSocket extends EventTarget {
  readyState = 1
  accept = vi.fn()
  close = vi.fn(() => {
    this.readyState = 3
    this.dispatchEvent(new Event("close"))
  })

  send(value: string) {
    const request = JSON.parse(value) as { id: number, method: string }
    this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ id: request.id, result: { method: request.method } }),
    }))
  }

  emit(method: string, params: unknown) {
    this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ method, params, sessionId: "page-session" }),
    }))
  }
}

describe("cdp controller", () => {
  it("retains public session ownership until the socket closes after a failed release", async () => {
    const socket = new FakeSocket()
    const failure = new Error("WebSocket close failed")
    socket.close.mockImplementationOnce(() => { throw failure }).mockImplementationOnce(() => { socket.readyState = 2 })
    const controller = cdp({ connect: async () => socket })
    const providerClose = vi.fn()
    const session = await createBrowser({
      provider: {
        features: { liveHandoff: true },
        isolation: "provider",
        name: "cloudflare",
        open: () => ({
          close: providerClose,
          connection: { binding: {}, kind: "cloudflare-binding" as const, sessionId: "provider-session" },
          id: "provider-session",
        }),
      },
    }).open()
    const control = await session.attach(controller)

    await expect(control.release()).rejects.toBe(failure)
    expect(session.inspect().state).toBe("controlled")
    await expect(session.handoff({ audience: "next-run", mode: "live" })).rejects.toMatchObject({ code: "BROWSER_SESSION_STATE" })
    const first = control.release()
    const second = control.release()
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalledTimes(2))
    expect(session.inspect().state).toBe("controlled")
    await expect(control.client.send("Target.getTargets")).rejects.toThrow("after release")

    socket.readyState = 3
    socket.dispatchEvent(new Event("close"))
    await Promise.all([first, second])
    await control.release()
    expect(socket.close).toHaveBeenCalledTimes(2)
    expect(session.inspect().state).toBe("released")
    expect(providerClose).not.toHaveBeenCalled()
    await session.close()
  })

  it("waits for an already closing socket before releasing its lease", async () => {
    const socket = new FakeSocket()
    const attached = await cdp({ connect: async () => socket }).attach({
      endpoint: "ws://127.0.0.1:9222/devtools/browser/id",
      kind: "cdp",
    }, {
      provider: { features: { liveHandoff: true }, isolation: "trusted-host", name: "local" },
      sessionId: "public-id",
    })
    socket.readyState = 2
    const complete = vi.fn()
    const first = Promise.resolve(attached.release()).then(complete)
    const second = Promise.resolve(attached.release()).then(complete)
    await setImmediate()
    expect(complete).not.toHaveBeenCalled()
    expect(socket.close).not.toHaveBeenCalled()

    socket.readyState = 3
    socket.dispatchEvent(new Event("close"))
    await Promise.all([first, second])
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it("connects to Kitesurf without a persistent session id", async () => {
    const socket = new FakeSocket()
    const fetch = vi.fn(async (_input: unknown) => ({ webSocket: socket }))
    const attached = await cdp().attach({
      binding: { fetch },
      engine: "kitesurf",
      kind: "cloudflare-binding",
    }, {
      provider: { features: { liveHandoff: false }, isolation: "provider", name: "cloudflare" },
      sessionId: "public-id",
    })

    expect(String(fetch.mock.calls[0]![0])).toBe("http://fake.host/v1/devtools/browser?browser=kitesurf")
    await attached.release()
  })

  it("runs commands and detaches without terminating the provider session", async () => {
    const socket = new FakeSocket()
    const controller = cdp({ connect: async () => socket })
    const attached = await controller.attach({
      binding: { fetch: vi.fn() },
      kind: "cloudflare-binding",
      sessionId: "provider-secret",
    }, {
      provider: {
        features: { liveHandoff: true },
        isolation: "provider",
        name: "cloudflare",
      },
      sessionId: "public-id",
    })

    await expect(attached.client.send("Target.getTargets")).resolves.toEqual({ method: "Target.getTargets" })
    expect(attached.preservesSessionOnRelease).toBe(true)
    await attached.release()
    expect(socket.close).toHaveBeenCalledOnce()
    await expect(attached.client.send("Target.getTargets")).rejects.toThrow("after release")
  })

  it("forwards protocol events to subscribers", async () => {
    const socket = new FakeSocket()
    const attached = await cdp({ connect: async () => socket }).attach({
      binding: { fetch: vi.fn() },
      kind: "cloudflare-binding",
      sessionId: "provider-secret",
    }, {
      provider: { features: { liveHandoff: true }, isolation: "provider", name: "cloudflare" },
      sessionId: "public-id",
    })
    const listener = vi.fn()
    const stop = attached.client.on("Page.lifecycleEvent", listener)

    socket.emit("Page.lifecycleEvent", { loaderId: "document-loader", name: "load" })

    expect(listener).toHaveBeenCalledWith(
      { loaderId: "document-loader", name: "load" },
      "page-session",
    )
    stop()
    socket.emit("Page.lifecycleEvent", { loaderId: "ignored", name: "load" })
    expect(listener).toHaveBeenCalledOnce()
    await attached.release()
  })
})
