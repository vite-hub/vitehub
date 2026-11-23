import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { defineDatabase } from "../../database/src/definition.ts"
import { createNodePostgresDatabase } from "../../database/src/runtime/node-postgres.ts"
import { defineChatCapability } from "../src/chat-trigger.ts"
import { defineAgent } from "../src/index.ts"
import { createDefaultAgentInvocations } from "../src/invocations/default-core.ts"
import { libsqlChatStreamSql, registerChatStreamSql } from "../src/internal/chat-stream-sql.ts"
import { chatStreamTables, createSharedChatStreams } from "../src/internal/resumable-chat-shared.ts"
import { createResumableChatCustody } from "../src/internal/resumable-chat.ts"
import { installAgentInvocations, resolveAgentInvocationsSetting } from "../src/invocations/app.ts"
import { agentInvocationsPostgresSchema } from "../src/invocations/postgres.ts"
import { createChannelChatRouteHandler } from "../src/server/internal.ts"

import type { AgentInvocationsSetting } from "../src/invocations/app.ts"
import type { AgentRunContext } from "../src/types.ts"

const useDatabase = vi.fn()
vi.mock("@vite-hub/database", () => ({ useDatabase }))

const url = process.env.VITEHUB_TEST_POSTGRES_URL
const encoder = new TextEncoder()

type Handler = ReturnType<typeof createChannelChatRouteHandler>

function chatRequest(method: "DELETE" | "GET" | "POST", messageId = "message-1"): Request {
  const query = method === "GET" ? "?id=chat-1" : method === "DELETE" ? `?id=chat-1&messageId=${messageId}` : ""
  return new Request(`https://example.com/_vitehub/agents/support/chat${query}`, {
    ...(method === "POST"
      ? { body: JSON.stringify({ id: "chat-1", messageId, messages: [{ id: messageId, parts: [{ text: "hello", type: "text" }], role: "user" }] }) }
      : {}),
    headers: { "content-type": "application/json", "x-user": "user-1" },
    method,
  })
}

function sharedHandler(invocations: AgentInvocationsSetting, run: (context: AgentRunContext) => Response | Promise<Response>): Handler {
  return createChannelChatRouteHandler(
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    defineAgent({ capabilities: [defineChatCapability()], driver: { run }, invocations }) as never,
    {
      admission: { authenticate: ({ request }) => request.headers.get("x-user") || false },
      resumable: { owner: ({ auth }) => String(auth), scope: "shared" },
    },
  )
}

function controlledStream(): { body: ReadableStream<Uint8Array>, controller: ReadableStreamDefaultController<Uint8Array>, cancelled: ReturnType<typeof vi.fn> } {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const cancelled = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    cancel: cancelled,
    start(value) {
      controller = value
    },
  })
  return { body, cancelled, controller }
}

function frame(index: number): string {
  return `data: {"type":"text-delta","delta":"part ${index} ${"x".repeat(index % 7)}"}\n\n`
}

async function readFrames(body: ReadableStream<Uint8Array>, count: number): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>, text: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (text.split("\n\n").length - 1 < count) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  return { reader, text }
}

interface Processes {
  a: AgentInvocationsSetting
  b: AgentInvocationsSetting
}

function sharedStreamScenarios(processes: () => Processes) {
  it("resumes a stream on process B after the client leaves process A in the middle", async () => {
    const { a, b } = processes()
    const source = controlledStream()
    const runA = vi.fn(() => new Response(source.body, { headers: { "content-type": "text/event-stream" } }))
    const runB = vi.fn(() => new Response("must not run"))
    const [processA, processB] = [sharedHandler(a, runA), sharedHandler(b, runB)]
    const frames = Array.from({ length: 300 }, (_, index) => frame(index))

    const first = await processA(chatRequest("POST"), { agentName: "support" })
    expect(first.status).toBe(200)
    for (const value of frames.slice(0, 100)) source.controller.enqueue(encoder.encode(value))
    const partial = await readFrames(first.body!, 40)
    await partial.reader.cancel("browser disconnected")
    expect(frames.join("").startsWith(partial.text)).toBe(true)

    const resumed = await processB(chatRequest("GET"), { agentName: "support" })
    expect(resumed.status).toBe(200)
    expect(resumed.headers.get("content-type")).toBe("text/event-stream")
    expect(resumed.headers.get("x-vitehub-message-id")).toBe("message-1")
    expect(resumed.headers.get("x-vitehub-run-id")).toBe(first.headers.get("x-vitehub-run-id"))
    const resumedText = resumed.text()
    for (const value of frames.slice(100)) source.controller.enqueue(encoder.encode(value))
    source.controller.close()

    expect(await resumedText).toBe(frames.join(""))
    expect(source.cancelled).not.toHaveBeenCalled()
    expect(runA).toHaveBeenCalledOnce()
    expect(runB).not.toHaveBeenCalled()

    const duplicate = await processB(chatRequest("POST"), { agentName: "support" })
    await expect(duplicate.text()).resolves.toBe(frames.join(""))
    expect(runB).not.toHaveBeenCalled()
  })

  it("resumes a finished stream on process B to its full content", async () => {
    const { a, b } = processes()
    const bytes = Uint8Array.from({ length: 700_000 }, (_, index) => (index * 31) % 251)
    const processA = sharedHandler(a, () => new Response(bytes, { headers: { "content-type": "application/octet-stream" } }))
    const processB = sharedHandler(b, () => new Response("must not run"))

    const first = await processA(chatRequest("POST", "message-2"), { agentName: "support" })
    expect(Buffer.from(await first.arrayBuffer()).equals(bytes)).toBe(true)

    const resumed = await processB(chatRequest("GET"), { agentName: "support" })
    expect(resumed.headers.get("x-vitehub-message-id")).toBe("message-2")
    expect(Buffer.from(await resumed.arrayBuffer()).equals(bytes)).toBe(true)
  })

  it("stops the writer on process A from a DELETE on process B", async () => {
    const { a, b } = processes()
    const source = controlledStream()
    const processA = sharedHandler(a, () => new Response(source.body))
    const processB = sharedHandler(b, () => new Response("must not run"))

    const first = await processA(chatRequest("POST", "message-3"), { agentName: "support" })
    source.controller.enqueue(encoder.encode("first"))
    const partial = await readFrames(first.body!, 0)
    await partial.reader.cancel("browser disconnected")
    const resumed = await processB(chatRequest("GET"), { agentName: "support" })
    const resumedReader = resumed.body!.getReader()
    await expect(resumedReader.read()).resolves.toEqual({ done: false, value: encoder.encode("first") })

    const stopped = await processB(chatRequest("DELETE", "message-3"), { agentName: "support" })
    expect(stopped.status).toBe(204)
    await vi.waitFor(() => expect(source.cancelled).toHaveBeenCalledWith("Cancelled by the web chat client."), { timeout: 5_000 })
    await expect(resumedReader.read()).resolves.toMatchObject({ done: true })
    const after = await processB(chatRequest("GET"), { agentName: "support" })
    expect(after.status).toBe(204)
  })
}

describe("shared resumable chat on SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "vitehub-shared-chat-"))
  let file = 0
  let current: Processes
  afterAll(() => rmSync(directory, { force: true, recursive: true }))
  beforeEach(() => {
    const databaseUrl = pathToFileURL(join(directory, `journal-${++file}.sqlite`)).href
    const journal = () => createDefaultAgentInvocations({
      databaseUrl,
      env: {},
      libsql: () => import("../src/invocations/default-libsql.ts"),
      projectRoot: directory,
    })
    current = { a: journal(), b: journal() }
  })

  sharedStreamScenarios(() => current)

  it("signals the Driver when DELETE arrives before its response", async () => {
    let start!: () => void
    let cancel!: (reason: unknown) => void
    const started = new Promise<void>(resolve => start = resolve)
    const cancelled = new Promise<unknown>(resolve => cancel = resolve)
    const processA = sharedHandler(current.a, async ({ input: { abortSignal } }) => {
      if (!abortSignal) throw new Error("The Driver did not receive a cancellation signal")
      start()
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => {
          cancel(abortSignal.reason)
          resolve()
        }, { once: true })
      })
      return new Response("stopped")
    })
    const processB = sharedHandler(current.b, () => new Response("must not run"))
    const pending = processA(chatRequest("POST"), { agentName: "support" })
    await Promise.race([started, pending.then(() => { throw new Error("The Driver returned before cancellation") })])
    expect((await processB(chatRequest("DELETE"), { agentName: "support" })).status).toBe(204)
    await expect(cancelled).resolves.toBe("Cancelled by the web chat client.")
    await pending
  })

  it("rejects the shared scope when the journal keeps no database", async () => {
    const run = vi.fn(() => new Response("must not run"))
    const response = await sharedHandler({ store: "memory" }, run)(chatRequest("POST"), { agentName: "support" })
    expect(response.status).toBe(500)
    expect(run).not.toHaveBeenCalled()

    const custody = createResumableChatCustody<{ auth: string }>({ owner: ({ auth }) => auth, scope: "shared" }, { journal: () => resolveAgentInvocationsSetting("memory") })
    await expect(custody.session({ auth: "user-1" }, { agentName: "support", channelId: "http", chatId: "chat-1" }))
      .rejects.toMatchObject({ code: "AGENT_RESUMABLE_CHAT_JOURNAL_UNSUPPORTED" })
  })
})

it("keeps the original response open until the final shared chunk is committed", async () => {
  const { createClient } = await import("@libsql/client")
  const client = createClient({ url: ":memory:" })
  const sql = libsqlChatStreamSql(client)
  const journal = {}
  let openGate!: () => void
  let startWriting!: () => void
  const gate = new Promise<void>(resolve => openGate = resolve)
  const writing = new Promise<void>(resolve => startWriting = resolve)
  registerChatStreamSql(journal, async () => ({
    ...sql,
    async query(text, params) {
      if (text.startsWith(`INSERT INTO ${chatStreamTables.chunks}`)) {
        startWriting()
        await gate
      }
      return await sql.query(text, params)
    },
  }))
  try {
    const session = await createSharedChatStreams({ journal: () => journal, ttlMs: 60_000 }).session("chat")
    const claim = await session.claim("message")
    if (claim.kind !== "claimed") throw new Error("Expected a new claim")
    const response = await claim.complete(new Response("hello"), { waitUntil() {} })
    const reader = response.body!.getReader()
    await expect(reader.read()).resolves.toEqual({ done: false, value: encoder.encode("hello") })
    const eof = reader.read()
    await writing
    try {
      expect(await Promise.race([eof, new Promise(resolve => setTimeout(() => resolve("waiting"), 0))])).toBe("waiting")
    } finally {
      openGate()
      await eof
    }
    await expect((await session.latest())!.text()).resolves.toBe("hello")
  } finally {
    client.close()
  }
})

describe("shared resumable chat on a libSQL Database", () => {
  const directory = mkdtempSync(join(tmpdir(), "vitehub-shared-chat-database-"))
  let file = 0
  afterAll(() => rmSync(directory, { force: true, recursive: true }))
  beforeEach(async () => {
    const { createClient } = await import("@libsql/client")
    const { drizzle } = await import("drizzle-orm/libsql")
    const databaseUrl = pathToFileURL(join(directory, `database-${++file}.sqlite`)).href
    const databases = { a: drizzle({ client: createClient({ url: databaseUrl }) }), b: drizzle({ client: createClient({ url: databaseUrl }) }) }
    useDatabase.mockImplementation((name: "a" | "b") => ({ db: databases[name] }))
    installAgentInvocations({ database: () => import("../src/invocations/database.ts") })
  })
  afterAll(() => installAgentInvocations({}))

  sharedStreamScenarios(() => ({
    a: { database: "a", store: "database" },
    b: { database: "b", store: "database" },
  }))
})

describe.skipIf(!url)("shared resumable chat on a Postgres server", () => {
  const schema = `vitehub_test_${randomUUID().replaceAll("-", "")}`
  const pools: Array<{ end: () => Promise<void> }> = []
  const nodePostgres = (track = true) => {
    const definition = defineDatabase({ connection: { url: { kind: "env-variable", source: { kind: "env", name: "VITEHUB_TEST_SHARED_CHAT_DATABASE_URL" } } }, dialect: "postgresql", driver: "node-postgres", schema: {} })
    const db = createNodePostgresDatabase(definition, { binding: "DB" })
    if (track) pools.push(Reflect.get(db, "$client"))
    return db
  }
  const scopedUrl = (name: string) => {
    const scoped = new URL(url!)
    scoped.searchParams.set("options", `-c search_path=${name}`)
    return scoped.href
  }
  let admin: postgres.Sql
  let databases: Record<"a" | "b", ReturnType<typeof nodePostgres>>
  beforeAll(() => {
    admin = postgres(url!, { max: 1 })
    process.env.VITEHUB_TEST_SHARED_CHAT_DATABASE_URL = scopedUrl(schema)
    databases = { a: nodePostgres(), b: nodePostgres() }
  })

  beforeEach(async () => {
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    for (const statement of await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...agentInvocationsPostgresSchema }))) {
      await databases.a.execute(statement.replaceAll('"public".', ""))
    }
    useDatabase.mockImplementation((name: "a" | "b") => ({ db: databases[name] }))
    installAgentInvocations({ database: () => import("../src/invocations/database.ts") })
  })
  afterAll(async () => {
    installAgentInvocations({})
    await Promise.all(pools.map(pool => pool.end()))
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin?.end()
    delete process.env.VITEHUB_TEST_SHARED_CHAT_DATABASE_URL
  })

  sharedStreamScenarios(() => ({
    a: { database: "a", store: "database" },
    b: { database: "b", store: "database" },
  }))

  it("names the missing chat stream tables", async () => {
    const database = nodePostgres()
    await admin.unsafe(`DROP TABLE ${schema}.vitehub_agent_chat_stream_chunks, ${schema}.vitehub_agent_chat_streams`)
    useDatabase.mockImplementation(() => ({ db: database }))
    const custody = createResumableChatCustody<{ auth: string }>({ owner: ({ auth }) => auth, scope: "shared" }, { journal: () => resolveAgentInvocationsSetting({ database: "c", store: "database" }) })
    await expect(custody.session({ auth: "user-1" }, { agentName: "support", channelId: "http", chatId: "chat-1" })).rejects.toMatchObject({
      code: "AGENT_RESUMABLE_CHAT_POSTGRES_TABLES_MISSING",
      message: expect.stringContaining("\"vitehub_agent_chat_streams\" or \"vitehub_agent_chat_stream_chunks\""),
    })
  })

  it("resolves the current client of a stable Database proxy", async () => {
    const proxy = nodePostgres(false)
    useDatabase.mockReturnValue({ db: proxy })
    const { databaseChatStreamSql } = await import("../src/invocations/database.ts")
    const first = databaseChatStreamSql()
    await expect(first.query("SELECT current_schema() AS schema")).resolves.toEqual([{ schema }])
    process.env.VITEHUB_TEST_SHARED_CHAT_DATABASE_URL = scopedUrl("pg_catalog")
    try {
      pools.push(Reflect.get(proxy, "$client"))
      const second = databaseChatStreamSql()
      expect(second).not.toBe(first)
      await expect(second.query("SELECT current_schema() AS schema")).resolves.toEqual([{ schema: "pg_catalog" }])
    } finally {
      process.env.VITEHUB_TEST_SHARED_CHAT_DATABASE_URL = scopedUrl(schema)
    }
  })
})
