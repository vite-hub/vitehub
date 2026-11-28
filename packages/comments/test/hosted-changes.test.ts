// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"

import { mountHostedComments } from "../src/embed/tools.ts"
import { onOverlayBackendChange } from "../src/overlay/api.ts"

import type { EmbedFrame } from "../src/embed/protocol.ts"

vi.mock("@vite-hub/internal/runtime/page-tools-loader", () => ({ loadViteHubPageTools: vi.fn(), stopViteHubPageTools: vi.fn() }))

describe("the hosted overlay", () => {
  it("loads the threads again each time the frame says that they changed, until it stops", async () => {
    const listeners = new Set<() => void>()
    const frame: EmbedFrame = {
      call: async () => ({ id: 0, ok: true, value: null, people: [] }),
      onChange(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    await mountHostedComments(Promise.resolve(frame), { id: "p-1", console: "https://console.example.com" })
    const refresh = vi.fn()
    const stop = onOverlayBackendChange(refresh)
    await vi.waitFor(() => expect(listeners.size).toBe(1))
    for (const listener of listeners) listener()
    for (const listener of listeners) listener()
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
    expect(listeners.size).toBe(0)
  })

  it("does not listen when it stops before the frame connects", async () => {
    const listeners = new Set<() => void>()
    let connect: (frame: EmbedFrame) => void = () => undefined
    const frame = new Promise<EmbedFrame>((resolve) => {
      connect = resolve
    })
    await mountHostedComments(frame, { id: "p-2", console: "https://console.example.com" })
    const stop = onOverlayBackendChange(vi.fn())
    stop()
    connect({
      call: async () => ({ id: 0, ok: true, value: null, people: [] }),
      onChange(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    })
    await frame
    await Promise.resolve()
    expect(listeners.size).toBe(0)
  })
})
