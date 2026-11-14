import * as decoding from "lib0/decoding"
import { describe, expect, it } from "vitest"

import type { RealtimePresenceDefinition } from "../src/types.ts"
import { decodeRealtimeRequestFramePayload, encodeRealtimeRequestFrame, messageRealtimeRequest } from "../src/protocol.ts"
import { requestRealtimeRoom } from "../src/server.ts"
import { FakeSql, createTestServer, settle } from "./harness.ts"
import type { TestClient } from "./harness.ts"

const pages: RealtimePresenceDefinition = { document: false, requests: true }

/** The browser's answer to its last request, sent through the room's WebSocket hooks. */
function answer(client: TestClient, value: { ok: true, body: unknown } | { ok: false, why: string }, peer: object = client.peer) {
  const request = client.requests.at(-1)
  if (!request) throw new Error("The client got no request.")
  const hooks = (client.response as Response & { crossws: { message(peer: object, message: { uint8Array(): Uint8Array }): void } }).crossws
  hooks.message(peer, { uint8Array: () => encodeRealtimeRequestFrame({ kind: "answer", id: request.id, ...value }) })
}

describe("requestRealtimeRoom()", () => {
  it("encodes request and answer frames, and reads nothing else as one", () => {
    const frame = encodeRealtimeRequestFrame({ kind: "request", id: "r1", body: { method: "snapshot" } })
    const decoder = decoding.createDecoder(frame)
    expect(decoding.readVarUint(decoder)).toBe(messageRealtimeRequest)
    expect(decodeRealtimeRequestFramePayload(decoder)).toEqual({ kind: "request", id: "r1", body: { method: "snapshot" } })
    const bad = decoding.createDecoder(encodeRealtimeRequestFrame({ kind: "answer", id: "", ok: true, body: 1 }))
    decoding.readVarUint(bad)
    expect(decodeRealtimeRequestFramePayload(bad)).toBeUndefined()
  })

  it("asks the one browser in the room and resolves its answer", async () => {
    const server = createTestServer(pages)
    const page = await server.connect("page-1")
    await settle()
    const pending = requestRealtimeRoom("docs", "page-1", { method: "snapshot" }, { wait: 0 })
    await settle()
    expect(page.requests).toEqual([{ kind: "request", id: expect.any(String), body: { method: "snapshot" } }])
    answer(page, { ok: true, body: [{ ref: "c1", component: "select" }] })

    await expect(pending).resolves.toEqual([undefined, [{ ref: "c1", component: "select" }]])
  })

  it("names why a request found nobody to answer", async () => {
    const server = createTestServer(pages)
    const [empty] = await requestRealtimeRoom("docs", "page-1", {}, { wait: 0 })
    expect(empty?.code).toBe("REALTIME_ROOM_EMPTY")

    await server.connect("page-1")
    await server.connect("page-1")
    await settle()
    const [crowded] = await requestRealtimeRoom("docs", "page-1", {}, { wait: 0 })
    expect(crowded).toMatchObject({ code: "REALTIME_ROOM_CROWDED", why: "2 browsers are in the room, and a request goes to one browser only." })

    createTestServer({ document: false })
    const [off] = await requestRealtimeRoom("docs", "page-1", {}, { wait: 0 })
    expect(off?.code).toBe("REALTIME_ROOM_REQUESTS_OFF")
  })

  it("waits for a browser to join, such as after a reload", async () => {
    const server = createTestServer(pages)
    const pending = requestRealtimeRoom("docs", "page-1", {}, { wait: 2_000 })
    const page = await server.connect("page-1")
    await expect.poll(() => page.requests.length).toBe(1)
    answer(page, { ok: true, body: "joined" })
    await expect(pending).resolves.toEqual([undefined, "joined"])
  })

  it("takes the answer only from the browser it asked", async () => {
    const server = createTestServer(pages)
    const page = await server.connect("page-1")
    const other = await server.connect("page-2")
    await settle()
    const pending = requestRealtimeRoom("docs", "page-1", {}, { wait: 0, timeout: 200 })
    await settle()
    answer(page, { ok: true, body: "forged" }, other.peer)

    const [error] = await pending
    expect(error).toMatchObject({ code: "REALTIME_ROOM_TIMEOUT", why: "The browser did not answer in 0.2 seconds." })
  })

  it("fails at once when the browser leaves, refuses, or the caller aborts", async () => {
    const server = createTestServer(pages)
    const page = await server.connect("page-1")
    await settle()
    const leaving = requestRealtimeRoom("docs", "page-1", {}, { wait: 0 })
    await settle()
    page.close()
    expect((await leaving)[0]?.code).toBe("REALTIME_ROOM_EMPTY")

    const again = await server.connect("page-1")
    await settle()
    const refused = requestRealtimeRoom("docs", "page-1", {}, { wait: 0 })
    await settle()
    answer(again, { ok: false, why: "This page does not answer requests." })
    expect((await refused)[0]).toMatchObject({ code: "REALTIME_ROOM_REFUSED", why: "The browser could not answer: This page does not answer requests." })

    const controller = new AbortController()
    const aborted = requestRealtimeRoom("docs", "page-1", {}, { wait: 0, signal: controller.signal })
    await settle()
    controller.abort()
    expect((await aborted)[0]?.code).toBe("REALTIME_ROOM_ABORTED")
  })

  it("goes through the Durable Object and keeps the error code", async () => {
    const sql = new FakeSql()
    const server = createTestServer(pages, { durable: sql })
    const page = await server.connect("page-1")
    await settle()
    // The Worker's binding: each request reaches the handler inside the Durable Object.
    const durableObjects = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (request: Request) => {
          expect(request.headers.get("x-vitehub-realtime-request")).toBe("1")
          const inside = new Request(request.url.replace("https://vitehub.internal", "https://example.com"), request) as Request & { runtime?: unknown }
          inside.runtime = { cloudflare: { env: {}, context: { storage: { sql: sql.carrier } } } }
          return server.handler.fetch(inside)
        },
      }),
    }
    const pending = requestRealtimeRoom("docs", "page-1", { method: "query" }, { durableObjects, wait: 0 })
    await expect.poll(() => page.requests.length).toBe(1)
    answer(page, { ok: true, body: { items: [] } })
    await expect(pending).resolves.toEqual([undefined, { items: [] }])

    const [crowded] = await requestRealtimeRoom("docs", "page-2", {}, { durableObjects, wait: 0 })
    expect(crowded?.code).toBe("REALTIME_ROOM_EMPTY")
  })

  it("takes the answer through the hooks crossws restores after a Durable Object hibernates", async () => {
    const sql = new FakeSql()
    const server = createTestServer(pages, { durable: sql })
    const page = await server.connect("page-1")
    await settle()
    const pending = requestRealtimeRoom("docs", "page-1", {}, { wait: 0 })
    await settle()
    // crossws restores the peer with a bare GET of its first URL and asks the app for hooks again.
    const restored = await server.handler.fetch(new Request("https://example.com/api/_vitehub/realtime/docs/page-1")) as Response & { crossws?: { message(peer: object, message: { uint8Array(): Uint8Array }): void } }
    const request = page.requests.at(-1)!
    restored.crossws!.message(page.peer, { uint8Array: () => encodeRealtimeRequestFrame({ kind: "answer", id: request.id, ok: true, body: "after hibernation" }) })
    await expect(pending).resolves.toEqual([undefined, "after hibernation"])
  })

  it("ignores an answer that no request waits for", async () => {
    const server = createTestServer({ document: false })
    const page = await server.connect("page-1")
    await settle()
    const hooks = (page.response as Response & { crossws: { message(peer: object, message: { uint8Array(): Uint8Array }): void } }).crossws
    hooks.message(page.peer, { uint8Array: () => encodeRealtimeRequestFrame({ kind: "answer", id: "nobody", ok: true, body: 1 }) })
    await settle()
    expect(page.closed).toBeUndefined()
  })
})

describe("a Definition with scope: \"user\"", () => {
  // `identify` stands in for the Auth session: the test names the person in a header.
  const perPerson: RealtimePresenceDefinition = {
    document: false,
    requests: true,
    scope: "user",
    identify: ({ request }) => {
      const id = request.headers.get("x-person")
      return id ? { id } : null
    },
  }

  it("keeps one room per person for the same room id, and asks only the named person's", async () => {
    const server = createTestServer(perPerson)
    const ada = await server.connect("page-1", { headers: { "x-person": "ada" } })
    const grace = await server.connect("page-1", { headers: { "x-person": "grace" } })
    await settle()
    // Two people in the same room id are not a crowd: each is alone in their own room.
    const pending = requestRealtimeRoom("docs", "page-1", { method: "snapshot" }, { wait: 0, user: "ada" })
    await settle()
    expect(ada.requests).toHaveLength(1)
    expect(grace.requests).toHaveLength(0)
    answer(ada, { ok: true, body: "ada's page" })
    await expect(pending).resolves.toEqual([undefined, "ada's page"])

    // Grace cannot answer for Ada's room, and a request for her room reaches only her.
    const forged = requestRealtimeRoom("docs", "page-1", {}, { wait: 0, timeout: 200, user: "ada" })
    await settle()
    answer(ada, { ok: true, body: "late" }, grace.peer)
    expect((await forged)[0]?.code).toBe("REALTIME_ROOM_TIMEOUT")
    const [empty] = await requestRealtimeRoom("docs", "page-1", {}, { wait: 0, user: "edsger" })
    expect(empty?.code).toBe("REALTIME_ROOM_EMPTY")
  })

  it("puts everyone without a session in one anonymous scope", async () => {
    const server = createTestServer(perPerson)
    const visitor = await server.connect("page-1")
    await settle()
    const pending = requestRealtimeRoom("docs", "page-1", {}, { wait: 0, user: null })
    await settle()
    expect(visitor.requests).toHaveLength(1)
    answer(visitor, { ok: true, body: "anonymous" })
    await expect(pending).resolves.toEqual([undefined, "anonymous"])
    const [signedIn] = await requestRealtimeRoom("docs", "page-1", {}, { wait: 0, user: "ada" })
    expect(signedIn?.code).toBe("REALTIME_ROOM_EMPTY")
  })

  it("refuses a request that names no person", async () => {
    const server = createTestServer(perPerson)
    await server.connect("page-1", { headers: { "x-person": "ada" } })
    await settle()
    const [error] = await requestRealtimeRoom("docs", "page-1", {}, { wait: 0 })
    expect(error).toMatchObject({ code: "REALTIME_ROOM_REFUSED" })
    expect(error?.why).toContain("{ user }")
  })

  it("keeps a room id from naming another person's scope", async () => {
    const server = createTestServer(perPerson)
    const ada = await server.connect("page-1", { headers: { "x-person": "ada" } })
    // An anonymous visitor asks for a room whose id looks like Ada's scope.
    const visitor = await server.connect(encodeURIComponent("user:ada") + "/page-1")
    await settle()
    const pending = requestRealtimeRoom("docs", "page-1", {}, { wait: 0, user: "ada" })
    await settle()
    expect(visitor.requests).toHaveLength(0)
    answer(ada, { ok: true, body: "ada" })
    await expect(pending).resolves.toEqual([undefined, "ada"])
  })
})
