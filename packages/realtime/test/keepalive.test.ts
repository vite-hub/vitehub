import { expect, it, vi } from "vitest"

// lib0, which y-websocket times its 30 second silence limit with, keeps the `Date.now` it finds when it loads.
vi.useFakeTimers()
const { connectRealtimeRoom } = await import("../src/client.ts")

it("keeps idle sockets open past y-websocket's 30 second silence limit while the server answers pings", async () => {
  const sockets: Array<{ closed: boolean, pings: number }> = []
  vi.stubGlobal("window", { location: { protocol: "https:", host: "site.test" } })
  vi.stubGlobal("WebSocket", class {
    OPEN = 1
    readyState = 0
    onmessage: ((event: { data: unknown }) => void) | null = null
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    state = { closed: false, pings: 0 }
    constructor() {
      sockets.push(this.state)
      setTimeout(() => {
        this.readyState = 1
        this.onopen?.()
      })
    }

    close() { this.state.closed = true }
    // The server sends no room traffic, only a pong for each ping.
    send(data: unknown) {
      if (data !== "ping") return
      this.state.pings++
      setTimeout(() => this.onmessage?.({ data: "pong" }))
    }
  })
  const room = connectRealtimeRoom("latest", "drop", { changes: true })
  try {
    await vi.advanceTimersByTimeAsync(65_000)
    expect(sockets).toEqual([{ closed: false, pings: 4 }, { closed: false, pings: 4 }])
    expect(room.status()).toBe("connected")
  }
  finally {
    room.destroy()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
