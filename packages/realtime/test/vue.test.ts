import { effectScope, nextTick, ref } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"

import { useRealtimeTiptap } from "../src/vue.ts"

const providers = vi.hoisted(() => [] as Array<{
  connect: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  statusHandler?: (event: { status: string }) => void
  syncHandler?: (value: boolean) => void
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
    on = vi.fn((event: string, handler: (value: unknown) => void) => {
      if (event === "status") this.statusHandler = handler as (event: { status: string }) => void
      if (event === "sync") this.syncHandler = handler as (value: boolean) => void
    })
    statusHandler?: (event: { status: string }) => void
    syncHandler?: (value: boolean) => void
    ws = { OPEN: 1, readyState: 1, send: vi.fn() }
    wsconnected = false

    constructor(_server: string, _room: string, public doc: object) {
      providers.push(this)
    }
  },
}))

afterEach(() => {
  vi.useRealTimers()
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

  it("ignores lifecycle events from replaced document providers", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const documentId = ref("first.md")
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", documentId))!
    const first = providers[1]!

    first.statusHandler?.({ status: "connected" })
    first.syncHandler?.(true)
    expect(realtime.status.value).toBe("connected")
    expect(realtime.synced.value).toBe(true)

    documentId.value = "second.md"
    await nextTick()
    const second = providers[2]!
    second.statusHandler?.({ status: "connected" })
    second.syncHandler?.(true)
    first.statusHandler?.({ status: "disconnected" })
    first.syncHandler?.(false)

    expect(realtime.status.value).toBe("connected")
    expect(realtime.synced.value).toBe(true)
    scope.stop()
  })

  it("paces queued Workspace changes below the server quota", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md")))!
    const workspaceProvider = providers[0]!
    workspaceProvider.disconnect()
    vi.useFakeTimers()

    for (let index = 0; index <= 100; index++) {
      realtime.workspace.notify({ operation: "update", path: `${index}.md` })
    }
    expect(workspaceProvider.ws.send).not.toHaveBeenCalled()

    workspaceProvider.connect()
    expect(workspaceProvider.ws.send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_100)
    expect(workspaceProvider.ws.send).toHaveBeenCalledTimes(101)
    scope.stop()
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

  it("rejects checkpoints without entering pending state while disabled", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md"), { enabled: false }))!

    await expect(realtime.history.checkpoint()).rejects.toThrow("Realtime is disabled.")
    expect(realtime.history.pending.value).toBe(false)
    scope.stop()
  })

  it("retries after a rejected checkpoint is reconciled", async () => {
    vi.stubGlobal("window", { location: { host: "example.com", protocol: "https:" } })
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { code: "REALTIME_CHECKPOINT_REJECTED" } }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: "# Saved", snapshot: { entries: {}, id: "snapshot" } })))
    vi.stubGlobal("fetch", fetch)
    const scope = effectScope()
    const realtime = scope.run(() => useRealtimeTiptap("docs", ref("page.md")))!

    await expect(realtime.history.checkpoint()).resolves.toEqual({ content: "# Saved", snapshot: { entries: {}, id: "snapshot" } })
    expect(fetch).toHaveBeenCalledTimes(2)
    scope.stop()
  })
})
