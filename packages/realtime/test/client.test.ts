import { afterEach, describe, expect, it, vi } from "vitest"

import { connectRealtimeRoom } from "../src/client.ts"

afterEach(() => vi.unstubAllGlobals())

describe("prebuilt presence clients", () => {
  it("passes page context on both connections and keeps the workspace protocol parameter", () => {
    const urls: URL[] = []
    vi.stubGlobal("window", { location: { protocol: "https:", host: "site.test" } })
    vi.stubGlobal("WebSocket", class {
      constructor(url: string) { urls.push(new URL(url)) }
      close() {}
      send() {}
    })
    const room = connectRealtimeRoom("comments", "pages/home", { changes: true, params: { page: "/public", workspace: "untrusted" } })
    try {
      expect(urls).toHaveLength(2)
      expect(urls.map(url => url.searchParams.get("page"))).toEqual(["/public", "/public"])
      expect(urls[1]!.searchParams.get("workspace")).toBe("events")
    }
    finally {
      room.destroy()
    }
  })

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
