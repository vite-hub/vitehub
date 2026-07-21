import { describe, expect, it, vi } from "vitest"

import { cdp } from "../src/controllers/cdp.ts"

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
}

describe("cdp controller", () => {
  it("runs commands and detaches without terminating the provider session", async () => {
    const socket = new FakeSocket()
    const controller = cdp({ connect: async () => socket })
    const attached = await controller.attach({
      binding: { fetch: vi.fn() },
      kind: "cloudflare-binding",
      sessionId: "provider-secret",
    }, {
      provider: {
        features: { artifacts: false, liveHandoff: true, stateExport: false, stateImport: false },
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
})
