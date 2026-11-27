import { describe, expect, it, vi } from "vitest"
import * as Y from "yjs"

import type { RealtimePresenceDefinition } from "../src/types.ts"
import { localNotifiers } from "../src/request.ts"
import { notifyRealtimeRoom, refreshRealtimeDocument } from "../src/server.ts"
import { FakeSql, appendParagraph, createClientAwareness, createMemoryBusNetwork, createTestServer, presence, settle } from "./harness.ts"

const runtime = vi.hoisted(() => ({ available: true, noticeBase: "/portal" }))
vi.mock("#vitehub/realtime/availability", () => ({ default: runtime }))

function presenceDefinition(): RealtimePresenceDefinition & { authorize: ReturnType<typeof vi.fn> } {
  return { authorize: vi.fn(() => true), document: false }
}

describe("rooms of a definition without a document", () => {
  it("shares presence, asks only for read access, and has no document to save or refresh", async () => {
    const definition = presenceDefinition()
    const server = createTestServer(definition)
    const ada = await server.connect("drops/abc")
    const grace = await server.connect("drops/abc")
    await settle()
    expect(ada.closed).toBeUndefined()

    createClientAwareness(ada).set({ user: { name: "Ada" } })
    await settle()

    expect(presence(grace).get(ada.doc.clientID)).toEqual({ user: { name: "Ada" } })
    expect(ada.controls).toEqual([])
    expect(definition.authorize.mock.calls.map(([context]) => [context.documentId, context.mode])).toEqual([["drops/abc", "read"], ["drops/abc", "read"]])
    for (const action of ["save", "refresh", "checkpoint"] as const) {
      expect((await server.post("drops/abc", action, { state: Y.encodeStateAsUpdate(new Y.Doc()) })).status).toBe(404)
    }
    expect(await refreshRealtimeDocument("docs", "drops/abc")).toBe(false)
  })

  it("closes a client that sends a document update", async () => {
    const client = await createTestServer(presenceDefinition()).connect("drops/abc")
    await settle()
    appendParagraph(client.doc, "Edit")
    await settle()

    expect(client.closed).toEqual({ code: 4400, reason: "This Realtime Definition has no document." })
  })

  it("keeps nothing in Durable Object storage", async () => {
    const sql = new FakeSql()
    const server = createTestServer(presenceDefinition(), { durable: sql })
    const ada = await server.connect("drops/abc")
    const grace = await server.connect("drops/abc")
    await settle()
    expect(ada.closed).toBeUndefined()

    createClientAwareness(ada).set({ user: { name: "Ada" } })
    await settle()
    expect(presence(grace).get(ada.doc.clientID)).toEqual({ user: { name: "Ada" } })
    ada.close()
    grace.close()

    expect(sql.exec).not.toHaveBeenCalled()
  })

  it("shares presence across instances without a room record", async () => {
    const network = createMemoryBusNetwork()
    const a = createTestServer(presenceDefinition(), { handler: { bus: () => network.bus() } })
    const b = createTestServer(presenceDefinition(), { handler: { bus: () => network.bus() } })
    const onA = await a.connect("drops/abc")
    const onB = await b.connect("drops/abc")
    await settle()
    expect(onA.closed).toBeUndefined()

    createClientAwareness(onA).set({ user: { name: "Ada" } })
    await settle()

    expect(presence(onB).get(onA.doc.clientID)).toEqual({ user: { name: "Ada" } })
    expect(network.writes).toEqual([])
    onA.close()
    await settle()
    expect(presence(onB).has(onA.doc.clientID)).toBe(false)
  })

  it("sends a server notice to every browser in the room, and to no other room", async () => {
    const server = createTestServer(presenceDefinition())
    const ada = await server.connect("drops/abc")
    const grace = await server.connect("drops/abc")
    const elsewhere = await server.connect("drops/other")
    await settle()

    await notifyRealtimeRoom("docs", "drops/abc", { type: "threads" })

    expect(ada.notices).toEqual([{ type: "threads" }])
    expect(grace.notices).toEqual([{ type: "threads" }])
    expect(elsewhere.notices).toEqual([])
    expect(ada.closed).toBeUndefined()
  })

  it("publishes from a writer with no local sockets or prior Realtime requests", async () => {
    const network = createMemoryBusNetwork()
    const reader = createTestServer(presenceDefinition(), { handler: { bus: () => network.bus() } })
    const page = await reader.connect("drops/abc")
    await settle()

    const registrations = [...localNotifiers()]
    localNotifiers().clear()
    try {
      const writer = createTestServer(presenceDefinition(), { handler: { bus: () => network.bus() } })
      await notifyRealtimeRoom("docs", "drops/abc", "changed")
      expect(writer.handler).toBeDefined()
    }
    finally {
      for (const registration of registrations) localNotifiers().add(registration)
    }
    await settle()

    expect(page.notices).toEqual(["changed"])
  })

  it("sends notices without sharing awareness in a notice-only room", async () => {
    const server = createTestServer({ ...presenceDefinition(), awareness: false })
    const ada = await server.connect("drops/abc")
    const grace = await server.connect("drops/abc")
    createClientAwareness(ada).set({ user: { name: "Ada" } })
    await settle()

    await notifyRealtimeRoom("docs", "drops/abc", "changed")

    expect(presence(grace).has(ada.doc.clientID)).toBe(false)
    expect(grace.notices).toEqual(["changed"])
  })

  it("sends a server notice through the Durable Object", async () => {
    const sql = new FakeSql()
    const server = createTestServer(presenceDefinition(), { durable: sql })
    const page = await server.connect("drops/abc")
    await settle()
    const durableObjects = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (request: Request) => {
          if (!new URL(request.url).pathname.startsWith("/portal/_vitehub/realtime/")) return Promise.resolve(new Response(null, { status: 404 }))
          const inside = new Request(request.url.replace("https://vitehub.internal", "https://example.com"), request) as Request & { runtime?: unknown }
          inside.runtime = { cloudflare: { env: {}, context: { storage: { sql: sql.carrier } } } }
          return server.handler.fetch(inside)
        },
      }),
    }

    await notifyRealtimeRoom("docs", "drops/abc", { type: "threads" }, { durableObjects })

    expect(page.notices).toEqual([{ type: "threads" }])
  })
})
