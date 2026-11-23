import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { defineDatabase } from "../../database/src/definition.ts"
import { createNodePostgresDatabase } from "../../database/src/runtime/node-postgres.ts"
import { defineChatCapability } from "../src/chat-trigger.ts"
import { defineAgent } from "../src/index.ts"
import { createDefaultAgentInvocations } from "../src/invocations/default-core.ts"
import { createResumableChatCustody } from "../src/internal/resumable-chat.ts"
import { installAgentInvocations, resolveAgentInvocationsSetting } from "../src/invocations/app.ts"
import { agentInvocationsPostgresSchema } from "../src/invocations/postgres.ts"
import { createChannelChatRouteHandler } from "../src/server/internal.ts"

import type { AgentInvocationsSetting } from "../src/invocations/app.ts"

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

function sharedHandler(invocations: AgentInvocationsSetting, run: () => Response): Handler {
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
    const resumedText = resumed.text()

    const stopped = await processB(chatRequest("DELETE", "message-3"), { agentName: "support" })
    expect(stopped.status).toBe(204)
    await vi.waitFor(() => expect(source.cancelled).toHaveBeenCalledWith("Cancelled by the web chat client."), { timeout: 5_000 })
    await expect(resumedText).resolves.toBe("first")
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
  const pools: Array<{ end: () => Promise<void> }> = []
  const nodePostgres = () => {
    const definition = defineDatabase({ connection: { url: { kind: "env-variable", source: { kind: "env", name: "VITEHUB_TEST_SHARED_CHAT_DATABASE_URL" } } }, dialect: "postgresql", driver: "node-postgres", schema: {} })
    const db = createNodePostgresDatabase(definition, { binding: "DB" })
    pools.push(Reflect.get(db, "$client"))
    return db
  }
  const dropAll = `DROP TABLE IF EXISTS vitehub_agent_chat_stream_chunks, vitehub_agent_chat_streams, vitehub_agent_invocations_observations, vitehub_agent_invocations`
  let databases: Record<"a" | "b", ReturnType<typeof nodePostgres>>
  beforeAll(() => {
    process.env.VITEHUB_TEST_SHARED_CHAT_DATABASE_URL = url
    databases = { a: nodePostgres(), b: nodePostgres() }
  })

  beforeEach(async () => {
    await databases.a.execute(dropAll)
    for (const statement of await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ ...agentInvocationsPostgresSchema }))) {
      await databases.a.execute(statement)
    }
    useDatabase.mockImplementation((name: "a" | "b") => ({ db: databases[name] }))
    installAgentInvocations({ database: () => import("../src/invocations/database.ts") })
  })
  afterAll(async () => {
    await databases.a.execute(dropAll)
    installAgentInvocations({})
    await Promise.all(pools.map(pool => pool.end()))
    delete process.env.VITEHUB_TEST_SHARED_CHAT_DATABASE_URL
  })

  sharedStreamScenarios(() => ({
    a: { database: "a", store: "database" },
    b: { database: "b", store: "database" },
  }))

  it("names the missing chat stream tables", async () => {
    const database = nodePostgres()
    await database.execute("DROP TABLE vitehub_agent_chat_stream_chunks, vitehub_agent_chat_streams")
    useDatabase.mockImplementation(() => ({ db: database }))
    const custody = createResumableChatCustody<{ auth: string }>({ owner: ({ auth }) => auth, scope: "shared" }, { journal: () => resolveAgentInvocationsSetting({ database: "c", store: "database" }) })
    await expect(custody.session({ auth: "user-1" }, { agentName: "support", channelId: "http", chatId: "chat-1" })).rejects.toMatchObject({
      code: "AGENT_RESUMABLE_CHAT_POSTGRES_TABLES_MISSING",
      message: expect.stringContaining("\"vitehub_agent_chat_streams\" or \"vitehub_agent_chat_stream_chunks\""),
    })
  })
})
