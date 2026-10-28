import { afterEach, describe, expect, it, vi } from "vitest"

import { connectRealtimeRoom } from "../src/client.ts"

afterEach(() => vi.unstubAllGlobals())

describe("prebuilt presence clients", () => {
  it.each([undefined, "/portal/"])("mounts presence and change sockets below %s", (baseURL) => {
    const urls: string[] = []
    vi.stubGlobal("window", { location: { protocol: "https:", host: "site.test" } })
    vi.stubGlobal("WebSocket", class {
      constructor(url: string) { urls.push(url) }
      close() {}
      send() {}
    })
    const room = connectRealtimeRoom("comments", "pages/home", { baseURL, changes: true })
    try {
      const prefix = baseURL === undefined ? "" : "/portal"
      expect(urls).toHaveLength(2)
      expect(urls[0]).toBe(`wss://site.test${prefix}/api/_vitehub/realtime/comments/pages/home`)
      expect(urls[1]).toContain(`wss://site.test${prefix}/api/_vitehub/realtime/comments/`)
    }
    finally {
      room.destroy()
    }
  })
})
