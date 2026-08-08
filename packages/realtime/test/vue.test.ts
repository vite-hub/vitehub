import { effectScope, nextTick, ref } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useRealtimeTiptap } from "../src/vue.ts"

const providers = vi.hoisted(() => [] as Array<{
  connect: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  ws: { send: ReturnType<typeof vi.fn> }
}>)

vi.mock("@vite-hub/auth/vue", () => ({
  useUserSession: () => ({ user: ref() }),
}))

vi.mock("y-websocket", () => ({
  WebsocketProvider: class {
    awareness = {
      getStates: () => new Map(),
      on: vi.fn(),
      setLocalState: vi.fn(),
      setLocalStateField: vi.fn(),
    }

    connect = vi.fn(() => {
      this.wsconnected = true
      this.statusHandler?.({ status: "connected" })
    })
    destroy = vi.fn()
    disconnect = vi.fn(() => this.wsconnected = false)
    messageHandlers: unknown[] = []
    on = vi.fn((event: string, handler: (event: { status: string }) => void) => {
      if (event === "status") this.statusHandler = handler
    })
    statusHandler?: (event: { status: string }) => void
    ws = { OPEN: 1, readyState: 1, send: vi.fn() }
    wsconnected = false

    constructor(_server: string, _room: string, public doc: object) {
      providers.push(this)
    }
  },
}))

afterEach(() => {
  providers.length = 0
  vi.unstubAllGlobals()
})

describe("useRealtimeTiptap", () => {
  it("connects providers only while enabled", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const enabled = ref(false)
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md"), { enabled }))!

    expect(providers).toHaveLength(1)
    expect(providers[0]!.connect).not.toHaveBeenCalled()
    expect(realtime.document.value).toBeUndefined()
    realtime.workspace.notify({ operation: "delete", path: "private.md" })

    enabled.value = true
    await nextTick()
    expect(providers).toHaveLength(2)
    expect(providers[0]!.connect).toHaveBeenCalledOnce()
    expect(providers[0]!.ws.send).not.toHaveBeenCalled()
    expect(realtime.document.value).toBeDefined()

    enabled.value = false
    await nextTick()
    expect(providers[0]!.disconnect).toHaveBeenCalled()
    expect(providers[1]!.destroy).toHaveBeenCalledOnce()
    expect(realtime.document.value).toBeUndefined()

    enabled.value = true
    await nextTick()
    expect(providers).toHaveLength(3)
    expect(providers[0]!.connect).toHaveBeenCalledTimes(2)
    expect(realtime.document.value).toBeDefined()
    scope.stop()
    expect(providers[0]!.destroy).toHaveBeenCalledOnce()
    expect(providers[2]!.destroy).toHaveBeenCalledOnce()
  })

  it("keeps checkpoint pending state honest across overlapping failures", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const responses: Array<(response: Response) => void> = []
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => responses.push(resolve))))
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md")))!

    const first = realtime.history.checkpoint()
    const second = realtime.history.checkpoint()
    expect(realtime.history.pending.value).toBe(true)

    responses[0]!(new Response(JSON.stringify({ content: "# Saved", snapshot: { entries: {}, id: "snapshot" } })))
    await expect(first).resolves.toEqual({ content: "# Saved", snapshot: { entries: {}, id: "snapshot" } })
    expect(realtime.history.pending.value).toBe(true)

    responses[1]!(new Response(JSON.stringify({ message: "publisher unavailable" }), { status: 500 }))
    await expect(second).rejects.toThrow("publisher unavailable")
    expect(realtime.history.pending.value).toBe(false)
    scope.stop()
  })
})
