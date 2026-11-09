import { afterAll, describe, expect, it, vi } from "vitest"
import postgres from "postgres"

import type { RealtimeBus } from "../src/bus-protocol.ts"
import type { RealtimeDefinition } from "../src/types.ts"
import { createPostgresRealtimeBus, createRedisRealtimeBus } from "../src/bus.ts"
import { appendParagraph, createClientAwareness, createMemoryAdapter, createStubEditor, createTestServer, paragraphs, presence } from "./harness.ts"

vi.mock("@vite-hub/auth/server", () => ({
  assertAuthOrigin: vi.fn(async () => {
    throw new Error("Fan-out tests do not use Auth.")
  }),
}))

// Each test connects two instances, and the first one creates the Postgres tables.
vi.setConfig({ testTimeout: 20_000 })

// Opt-in: `docker run -d -p 5432 postgres:17` and `docker run -d -p 6379 redis:7`, then set these variables.
const backends = [
  { name: "Postgres", url: process.env.VITEHUB_TEST_POSTGRES_URL, create: createPostgresRealtimeBus },
  { name: "Redis", url: process.env.VITEHUB_TEST_REDIS_URL, create: createRedisRealtimeBus },
] as const

async function waitFor(check: () => boolean, timeout = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  return check()
}

function definition(adapter: RealtimeDefinition["document"]): RealtimeDefinition {
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
    const [a, b] = buses.map(bus => createTestServer(definition(memory.adapter), { handler: { bus: () => bus } }))
    return { a: a!, b: b!, busA: buses[0]!, document, memory }
  }

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
