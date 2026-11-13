import { afterAll, describe, expect, it, vi } from "vitest"
import postgres from "postgres"
import * as Y from "yjs"

import type { RealtimeBus } from "../src/bus-protocol.ts"
import type { RealtimeDocumentDefinition } from "../src/types.ts"
import { defineDatabase } from "@vite-hub/database"
import { createPostgresDatabase } from "../../database/src/runtime/postgres.ts"

import { createPostgresRealtimeBus, createRealtimeNodeBus, createRedisRealtimeBus } from "../src/bus.ts"
import { appendParagraph, createClientAwareness, createMemoryAdapter, createStubEditor, createTestServer, paragraphs, presence } from "./harness.ts"

vi.mock("@vite-hub/auth/server", () => ({
  assertAuthOrigin: vi.fn(async () => {
    throw new Error("Fan-out tests do not use Auth.")
  }),
}))

// Each test connects two instances, and the first one creates the Postgres tables.
vi.setConfig({ testTimeout: 20_000 })

// Opt-in: `docker run -d -p 5432 postgres:17` and `docker run -d -p 6379 redis:7`, then set these variables.
const postgresUrl = process.env.VITEHUB_TEST_POSTGRES_URL
const backends = [
  { name: "Postgres", url: postgresUrl, create: (url: string, namespace?: string) => createPostgresRealtimeBus({ namespace, url }) },
  { name: "Redis", url: process.env.VITEHUB_TEST_REDIS_URL, create: (url: string, namespace?: string) => createRedisRealtimeBus(url, { namespace }) },
] as const

async function waitFor(check: () => boolean, timeout = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  return check()
}

function realtimeDefinition(adapter: RealtimeDocumentDefinition["document"]): RealtimeDocumentDefinition {
  return { document: adapter, editor: createStubEditor().editor }
}

const opened: RealtimeBus[] = []
afterAll(async () => {
  await Promise.allSettled(opened.map(bus => bus.close()))
})

describe.each(backends)("rooms shared through $name", ({ name, url, create }) => {
  async function twoInstances() {
    const buses = await Promise.all([create(url!), create(url!)])
    opened.push(...buses)
    const document = `fanout-${crypto.randomUUID()}`
    const memory = createMemoryAdapter({ [document]: { body: "Start" } })
    const [a, b] = buses.map(bus => createTestServer(realtimeDefinition(memory.adapter), { handler: { bus: () => bus } }))
    return { a: a!, b: b!, busA: buses[0]!, document, memory }
  }

  it.skipIf(!url)("keeps the pending save marker until the saved record replaces it", async () => {
    const bus = await create(url!)
    opened.push(bus)
    const room = `pending-${crypto.randomUUID()}`
    const epoch = crypto.randomUUID()
    const state = new Uint8Array([1, 2, 3])
    expect(await bus.writeRoom(room, { epoch, digest: "v1", state, pending: true }, null)).toBe(true)
    expect(await bus.readRoom(room)).toEqual({ epoch, digest: "v1", state, pending: true })
    expect(await bus.writeRoom(room, { epoch, digest: "v2", state }, epoch)).toBe(true)
    expect(await bus.readRoom(room)).toEqual({ epoch, digest: "v2", state, pending: false })
  })

  it.skipIf(!url)("sends an edit from a client on A to a client on B", async () => {
    const { a, b, document } = await twoInstances()
    const onA = await a.connect(document)
    expect(await waitFor(() => paragraphs(onA.doc).length === 1)).toBe(true)
    const onB = await b.connect(document)
    expect(await waitFor(() => paragraphs(onB.doc).length === 1)).toBe(true)

    appendParagraph(onA.doc, "From A")
    expect(await waitFor(() => paragraphs(onB.doc).includes("From A"))).toBe(true)
    appendParagraph(onB.doc, "From B")
    expect(await waitFor(() => paragraphs(onA.doc).includes("From B"))).toBe(true)
    expect([...onA.controls, ...onB.controls].some(control => control.type === "reset")).toBe(false)
  })

  it.skipIf(!url)("sends presence from A to B, and removes it from B when A stops", async () => {
    const { a, b, busA, document } = await twoInstances()
    const onA = await a.connect(document)
    const onB = await b.connect(document)
    expect(await waitFor(() => paragraphs(onB.doc).length === 1)).toBe(true)

    createClientAwareness(onA).set({ user: { name: "Ada" } })
    expect(await waitFor(() => presence(onB).has(onA.doc.clientID))).toBe(true)
    expect(presence(onB).get(onA.doc.clientID)).toEqual({ user: { name: "Ada" } })

    await busA.close()
    expect(await waitFor(() => !presence(onB).has(onA.doc.clientID))).toBe(true)
  })

  it.skipIf(!url)("sends an update larger than 8000 bytes", async () => {
    const { a, b, document } = await twoInstances()
    const onA = await a.connect(document)
    const onB = await b.connect(document)
    expect(await waitFor(() => paragraphs(onB.doc).length === 1)).toBe(true)

    const large = "x".repeat(20_000)
    appendParagraph(onA.doc, large)
    expect(await waitFor(() => paragraphs(onB.doc).includes(large))).toBe(true)
    if (name === "Postgres") {
      const sql = postgres(url!, { max: 1, onnotice: () => {} })
      try {
        const [row] = await sql`select count(*)::int as count from vitehub_realtime_messages where octet_length(payload) > 8000`
        expect(row?.count).toBeGreaterThan(0)
      }
      finally {
        await sql.end()
      }
    }
  })

  it.skipIf(!url)("keeps the rooms of two apps apart on one backend", async () => {
    const [appA1, appA2, appB] = await Promise.all([create(url!, "app-a"), create(url!, "app-a"), create(url!, "app-b")])
    opened.push(appA1, appA2, appB)
    // Both apps have a document with the same path, as two Content sites with `index.md`.
    const document = `index-${crypto.randomUUID()}.md`
    const [storeA, storeB] = [createMemoryAdapter({ [document]: { body: "Start" } }), createMemoryAdapter({ [document]: { body: "Start" } })]
    const a1 = createTestServer(realtimeDefinition(storeA.adapter), { handler: { bus: () => appA1 } })
    const a2 = createTestServer(realtimeDefinition(storeA.adapter), { handler: { bus: () => appA2 } })
    const b = createTestServer(realtimeDefinition(storeB.adapter), { handler: { bus: () => appB } })
    const [onA1, onA2, onB] = await Promise.all([a1.connect(document), a2.connect(document), b.connect(document)])
    expect(await waitFor(() => [onA1, onA2, onB].every(client => paragraphs(client.doc).length === 1))).toBe(true)

    appendParagraph(onA1.doc, "Only in app A")
    expect(await waitFor(() => paragraphs(onA2.doc).includes("Only in app A"))).toBe(true)
    createClientAwareness(onA1).set({ user: { name: "Ada" } })
    expect(await waitFor(() => presence(onA2).has(onA1.doc.clientID))).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(paragraphs(onB.doc)).toEqual(["Start"])
    expect(presence(onB).has(onA1.doc.clientID)).toBe(false)
    expect([...onA1.controls, ...onA2.controls, ...onB.controls].some(control => control.type === "reset")).toBe(false)
  })

  it.skipIf(!url)("saves the edits of both instances once each, without a conflict", async () => {
    const { a, b, document, memory } = await twoInstances()
    const onA = await a.connect(document)
    const onB = await b.connect(document)
    expect(await waitFor(() => paragraphs(onB.doc).length === 1 && paragraphs(onA.doc).length === 1)).toBe(true)
    appendParagraph(onA.doc, "A")
    appendParagraph(onB.doc, "B")
    expect(await waitFor(() => paragraphs(onA.doc).length === 3 && paragraphs(onB.doc).length === 3)).toBe(true)

    // Persistence saves after a 2 s debounce.
    expect(await waitFor(() => memory.store.get(document)?.body.split("\n\n").length === 3, 8_000)).toBe(true)
    expect(memory.store.get(document)!.body.split("\n\n").sort()).toEqual(["A", "B", "Start"])
    expect([...onA.controls, ...onB.controls].some(control => control.type === "reset")).toBe(false)
  })
})

describe("the Postgres bus on the Default Database", () => {
  it.skipIf(!postgresUrl).each([1, 2])("opens and saves concurrent rooms on a borrowed pool with max=%s", async (max) => {
    const url = new URL(postgresUrl!)
    url.searchParams.set("max", String(max))
    const definition = defineDatabase({ connection: { url: url.toString() }, dialect: "postgresql", schema: {} })
    const db = createPostgresDatabase(definition, { binding: "DB" })
    const client = Reflect.get(db, "$client")
    const bus = await createRealtimeNodeBus("auto", { databases: async () => ({ default: { db } }), env: {} })
    expect(bus?.authority).toBe("postgres")
    const documents = Array.from({ length: 4 }, () => `small-pool-${crypto.randomUUID()}`)
    const memory = createMemoryAdapter(Object.fromEntries(documents.map(id => [id, { body: "Start" }])))
    const server = createTestServer({
      ...realtimeDefinition({
        ...memory.adapter,
        async load(context) {
          await db.execute("select 1")
          return await memory.adapter.load(context)
        },
        async save(context, snapshot, options) {
          await db.execute("select 1")
          return await memory.adapter.save(context, snapshot, options)
        },
      }),
      persistence: false,
    }, { handler: { bus: () => bus } })
    try {
      let complete = false
      const connecting = Promise.all(documents.map(id => server.connect(id)))
      connecting.then(() => { complete = true }, () => {})
      expect(await waitFor(() => complete, 2_000)).toBe(true)
      const peers = await connecting
      expect(await waitFor(() => peers.every(peer => paragraphs(peer.doc)[0] === "Start"))).toBe(true)
      for (const peer of peers) appendParagraph(peer.doc, "Edit")
      const responses = await Promise.all(peers.map((peer, index) => server.post(documents[index]!, "save", { state: Y.encodeStateAsUpdate(peer.doc) })))
      expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200])
      expect([...memory.store.values()].every(document => document.body === "Start\n\nEdit")).toBe(true)
    }
    finally {
      await client.end({ timeout: 1 })
      await bus?.close()
    }
  })

  it.skipIf(!postgresUrl)("uses the client of a Database whose URL comes from another variable, and leaves it open", async () => {
    const saved = { DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: process.env.REDIS_URL, REALTIME_POSTGRES_URL: process.env.REALTIME_POSTGRES_URL }
    // An unrelated DATABASE_URL on a closed port: Realtime must not use it.
    process.env.DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/unrelated"
    delete process.env.REDIS_URL
    delete process.env.REALTIME_POSTGRES_URL
    process.env.VITEHUB_TEST_REALTIME_DATABASE_URL = postgresUrl
    const definition = defineDatabase({ connection: { url: { kind: "env-variable", source: { kind: "env", name: "VITEHUB_TEST_REALTIME_DATABASE_URL" } } }, dialect: "postgresql", schema: {} })
    const db = createPostgresDatabase(definition, { binding: "DB" })
    const databases = async () => ({ default: { db } })
    try {
      const buses = await Promise.all([createRealtimeNodeBus("auto", { databases }), createRealtimeNodeBus("auto", { databases })])
      expect(buses.map(bus => bus?.authority)).toEqual(["postgres", "postgres"])
      const document = `fanout-${crypto.randomUUID()}`
      const memory = createMemoryAdapter({ [document]: { body: "Start" } })
      const [a, b] = buses.map(bus => createTestServer(realtimeDefinition(memory.adapter), { handler: { bus: () => bus } }))
      const onA = await a!.connect(document)
      const onB = await b!.connect(document)
      expect(await waitFor(() => paragraphs(onB.doc).length === 1)).toBe(true)
      appendParagraph(onA.doc, "Through the Default Database")
      expect(await waitFor(() => paragraphs(onB.doc).includes("Through the Default Database"))).toBe(true)
      await Promise.all(buses.map(bus => bus?.close()))
      // The Database owns its client. Realtime leaves it open.
      await expect(db.execute("select 1")).resolves.toBeDefined()
    }
    finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await Reflect.get(db, "$client").end()
    }
  })
})
