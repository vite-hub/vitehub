import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { H3 } from "h3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDrizzleWebhookEndpointStore, createDrizzleWebhookStore, webhooksTables } from "../../webhooks/src/database.ts"
import { getMemberEndpoint } from "../../webhooks/src/index.ts"
import { installWebhooks } from "../../webhooks/src/runtime.ts"
import { defineComments } from "../src/index.ts"
import { installComments } from "../src/install.ts"
import { createCommentsHandler } from "../src/runtime/handler.ts"
import { commentsMcpTools } from "../src/runtime/mcp.ts"
import { commentSendsTables } from "../src/send/database.ts"
import { commentsMigration } from "./harness.ts"

import type { CommentsDatabase } from "../src/operations-core/store.ts"
import type { CommentsUser, CommentThread, DefineCommentsOptions } from "../src/types.ts"

// The guard resolves names. A real lookup would make the test depend on the network.
vi.mock("node:dns/promises", () => {
  const records: Record<string, string[]> = { "relay.t3.codes": ["104.21.3.218"], "hooks.example.com": ["93.184.215.14"], "intranet.example.com": ["10.0.0.7"] }
  const lookup = async (host: string) => {
    const addresses = records[host]
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" })
    return addresses.map(address => ({ address, family: 4 }))
  }
  return { lookup, default: { lookup } }
})

const origin = "https://notes.test"
const relay = "https://relay.t3.codes/hooks/wh_7c1d?token=t3-relay-token"
const people: Record<string, CommentsUser> = {
  ana: { id: "ana", name: "Ana", role: "editor" },
  bob: { id: "bob", name: "Bob", role: "editor" },
  cora: { id: "cora", name: "Cora", role: "editor", email: "Cora@Example.com", emailVerified: true },
  dan: { id: "dan", name: "Dan", role: "editor", email: "dan@example.com", emailVerified: false },
}
const threadLink = "t3-thread://v2/6f5c40a4-eb77-4249-a83a-c0d4f680b208/mcp:launch:b1810c72539f5d7c88d14a5e"

interface Delivery {
  url: string
  headers: Headers
  body: {
    event: string
    send: string
    page: string
    threads: string[]
    count: number
    read: { url: string, token: string } | null
    text: string
    data: unknown
  }
}

let deliveries: Delivery[] = []
/** Threads that the policy hides from everyone, to check that a token reads as the sender now. */
let hidden = new Set<string>()

async function setup(send: DefineCommentsOptions["send"] = true) {
  const client = createClient({ url: ":memory:" })
  await client.executeMultiple([commentsMigration, ...commentSendsTables.map(statement => `${statement};`), ...webhooksTables.map(statement => `${statement};`)].join("\n"))
  // SAFETY: The libSQL Drizzle database implements the batch contract that ViteHub Databases expose.
  const database = drizzle({ client }) as unknown as CommentsDatabase
  const db = drizzle({ client })
  installWebhooks({ webhooks: {}, store: createDrizzleWebhookStore(db), endpoints: createDrizzleWebhookEndpointStore(db) })
  const comments = defineComments({
    identify: ({ event }) => people[event["~standard"].req.headers.get("x-test-user") ?? ""] ?? null,
    authorize: ({ thread }) => !thread || !hidden.has(thread.id),
    send,
  })
  installComments(comments, { database, webhooks: () => import("../../webhooks/src/index.ts") })
  const app = new H3().all("/_vitehub/comments/**", createCommentsHandler({ comments, realtime: false }))
  const call = async (path: string, init: { method?: string, as?: keyof typeof people, json?: unknown, origin?: string | null, headers?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers)
    if (init.as) headers.set("x-test-user", init.as)
    if (init.json !== undefined) headers.set("content-type", "application/json")
    const method = init.method ?? (init.json === undefined ? "GET" : "POST")
    if (method !== "GET" && init.origin !== null) headers.set("origin", init.origin ?? origin)
    const response = await app.fetch(new Request(`${origin}/_vitehub/comments${path}`, { method, headers, ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }) }))
    return { status: response.status, body: await response.json() as { data?: any, error?: { code: string, why: string }, reason?: string } }
  }
  const page = "/notes/azores"
  const comment = async (as: keyof typeof people, body: string): Promise<CommentThread> => {
    const [error, thread] = await comments.create({ page, body, author: { id: people[as]!.id, name: people[as]!.name } })
    if (error) throw error
    return thread
  }
  const reply = async (threadId: string, as: keyof typeof people, body: string) => {
    const [error] = await comments.reply(threadId, { body, author: { id: people[as]!.id, name: people[as]!.name } })
    if (error) throw error
  }
  /** Start, pair with `url`, and Allow, as the pill and the agent do. Returns the result of Allow. */
  const connect = async (as: keyof typeof people = "ana", url = relay, thread?: unknown) => {
    const started = await call(`/send/start?page=${page}`, { method: "POST", as })
    const code: string = started.body.data.code
    const paired = await call("/send/pair", { json: { code, url, ...(thread === undefined ? {} : { thread }) }, origin: null })
    expect(paired.status).toBe(200)
    return { code, allowed: await call(`/send/allow?page=${page}`, { json: { code }, as }) }
  }
  return { comments, call, comment, reply, connect, page }
}

beforeEach(() => {
  deliveries = []
  hidden = new Set()
  vi.stubEnv("VITEHUB_WEBHOOKS_KEY", btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))
  const real = globalThis.fetch
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (!request.url.startsWith("https://relay.t3.codes/") && !request.url.startsWith("https://hooks.example.com/")) return real(input, init)
    deliveries.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) })
    return new Response(null, { status: 202 })
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("pairing", () => {
  it("gives a setup prompt that tells T3 how to create the webhook task", async () => {
    const { call, page } = await setup()
    const { status, body } = await call(`/send/start?page=${page}`, { method: "POST", as: "ana" })
    expect(status).toBe(200)
    expect(body.data.code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/)
    expect(body.data.agent).toEqual({ name: "T3 Code", logo: "t3", host: "relay.t3.codes" })
    const prompt: string = body.data.prompt
    for (const part of ["t3_thread_read", "T3CODE_THREAD_ID", "t3-thread://v2/<environmentId>/<threadId>", "\"thread\":\"<thread URL>\"", "schedule_task", "\"x-hub-signature-256\"", "\"encoding\":\"hex\"", "\"prefix\":\"sha256=\"", "{{headers.x-vitehub-delivery}}", "bindToCurrentThread set to true", "freshSession set to true", `${origin}/_vitehub/comments/send/pair`, body.data.code]) {
      expect(prompt).toContain(part)
    }
    expect(prompt).toMatch(/"secret":"whsec_[0-9a-f]{64}"/)
  })

  it("keeps the thread link of the pair post, and links Working and later sends to it", async () => {
    const { call, comment, connect, page } = await setup()
    await comment("ana", "The rental desk paragraph is too long")
    const { allowed } = await connect("ana", relay, threadLink)
    expect(allowed.body.data).toMatchObject({ status: "sent", thread: threadLink })
    expect((await call(`/send/status?page=${page}`, { as: "ana" })).body.data.working).toMatchObject({ thread: threadLink })
    await comment("ana", "And the photo credits")
    expect((await call(`/send?page=${page}`, { json: {}, as: "ana" })).body.data).toMatchObject({ status: "sent", thread: threadLink })
  })

  it.each([
    ["a javascript: link", "javascript:alert(document.cookie)"],
    ["a web link", "https://app.t3.codes/threads/abc"],
    ["another version", "t3-thread://v1/env/thread"],
    ["an extra segment", "t3-thread://v2/env/thread/extra"],
    ["a query", "t3-thread://v2/env/thread?x=1"],
    ["an object", { href: threadLink }],
  ])("drops %s as the thread link, and still pairs", async (_, thread) => {
    const { call, comment, connect, page } = await setup()
    await comment("ana", "The rental desk paragraph is too long")
    const { allowed } = await connect("ana", relay, thread)
    expect(allowed.body.data.status).toBe("sent")
    expect(allowed.body.data).not.toHaveProperty("thread")
    const status = (await call(`/send/status?page=${page}`, { as: "ana" })).body.data
    expect(status.working).toBeDefined()
    expect(status.working).not.toHaveProperty("thread")
  })

  it("gives the endpoint the member's name, and their email only when it is verified", async () => {
    const { comment, connect } = await setup()
    await comment("cora", "Swap the photos")
    await comment("dan", "Fix the map")
    await connect("cora")
    await connect("dan")
    expect((await getMemberEndpoint("cora"))[1]).toMatchObject({ ownerName: "Cora", ownerEmail: "cora@example.com" })
    expect((await getMemberEndpoint("dan"))[1]).toMatchObject({ ownerName: "Dan", ownerEmail: null })
    expect((await getMemberEndpoint("ana"))[1]).toBeNull()
  })

  it("refuses signed-out people", async () => {
    const { call, page } = await setup()
    expect((await call(`/send/start?page=${page}`, { method: "POST" })).status).toBe(403)
  })

  it("refuses a code that an agent already used", async () => {
    const { call, page } = await setup()
    const { body } = await call(`/send/start?page=${page}`, { method: "POST", as: "ana" })
    const code = body.data.code
    expect((await call("/send/pair", { json: { code, url: relay } })).body.data).toEqual({ status: "paired", agent: { name: "T3 Code", logo: "t3", host: "relay.t3.codes" } })
    const again = await call("/send/pair", { json: { code, url: "https://relay.t3.codes/hooks/other" } })
    expect(again).toMatchObject({ status: 409, body: { reason: "used", error: { code: "COMMENTS_SEND_CODE_USED" } } })
  })

  it("refuses a code older than 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { call, page } = await setup()
    const { body } = await call(`/send/start?page=${page}`, { method: "POST", as: "ana" })
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1)
    const late = await call("/send/pair", { json: { code: body.data.code, url: relay } })
    expect(late).toMatchObject({ status: 410, body: { reason: "expired" } })
    expect((await call(`/send/pair/${body.data.code}`, { as: "ana" })).body.data).toEqual({ status: "expired" })
  })

  it("refuses Allow by another person, and lets the one who copied the code allow", async () => {
    const { call, comment, page } = await setup()
    await comment("ana", "The rental desk paragraph is too long")
    const { body } = await call(`/send/start?page=${page}`, { method: "POST", as: "ana" })
    const code = body.data.code
    await call("/send/pair", { json: { code, url: relay } })
    expect((await call(`/send/pair/${code}`, { as: "bob" })).body.data).toEqual({ status: "expired" })
    const stolen = await call(`/send/allow?page=${page}`, { json: { code }, as: "bob" })
    expect(stolen.status).toBe(403)
    expect(await getMemberEndpoint("bob")).toEqual([undefined, null])
    expect(deliveries).toHaveLength(0)
    expect((await call(`/send/pair/${code}`, { as: "ana" })).body.data.status).toBe("paired")
    const allowed = await call(`/send/allow?page=${page}`, { json: { code }, as: "ana" })
    expect(allowed.body.data).toMatchObject({ status: "sent" })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.url).toBe(relay)
    expect(deliveries[0]!.headers.get("x-hub-signature-256")).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it.each([
    ["a host other than the T3 relay", "https://hooks.example.com/t3"],
    ["a private address", "https://10.0.0.7/hooks"],
    ["a name that resolves to a private address", "https://intranet.example.com/hooks"],
    ["plain http", "http://relay.t3.codes/hooks/abc"],
  ])("refuses %s and saves nothing", async (_, url) => {
    const { call, page } = await setup()
    const { body } = await call(`/send/start?page=${page}`, { method: "POST", as: "ana" })
    const refused = await call("/send/pair", { json: { code: body.data.code, url } })
    expect(refused).toMatchObject({ status: 422, body: { reason: "refused", error: { code: "COMMENTS_SEND_CODE_REFUSED" } } })
    expect((await call(`/send/pair/${body.data.code}`, { as: "ana" })).body.data).toEqual({ status: "refused" })
    expect((await call(`/send/allow?page=${page}`, { json: { code: body.data.code }, as: "ana" })).status).toBe(410)
    expect(await getMemberEndpoint("ana")).toEqual([undefined, null])
  })

  it("takes the pair post from any origin, and keeps the other routes same-origin", async () => {
    const { call, page } = await setup()
    const { body } = await call(`/send/start?page=${page}`, { method: "POST", as: "ana" })
    expect((await call("/send/pair", { json: { code: body.data.code, url: relay }, origin: "https://agent.example" })).status).toBe(200)
    for (const path of [`/send/start?page=${page}`, `/send/allow?page=${page}`, `/send?page=${page}`]) {
      const cross = await call(path, { json: { code: body.data.code }, as: "ana", origin: "https://evil.example" })
      expect(cross.status, path).toBe(403)
      expect(cross.body.error?.why).toContain("site's own pages")
    }
    expect((await call(`/send/pair/${body.data.code}`, { method: "DELETE", as: "ana", origin: "https://evil.example" })).status).toBe(403)
  })
})

describe("sends", () => {
  it("counts the threads that wait, from everyone, and not the ones already sent", async () => {
    const { call, comment, reply, connect, page } = await setup()
    const own = await comment("ana", "Move the cozido note up")
    const other = await comment("bob", "Is the ferry still running in May")
    expect((await call(`/send/status?page=${page}`, { as: "ana" })).body.data).toEqual({ count: 2 })
    await connect()
    expect(deliveries[0]!.body.threads.sort()).toEqual([own.id, other.id].sort())
    const after = (await call(`/send/status?page=${page}`, { as: "ana" })).body.data
    expect(after).toMatchObject({ count: 0, agent: { name: "T3 Code", host: "relay.t3.codes" }, working: { id: deliveries[0]!.body.send } })
    // A send with nothing new posts nothing.
    expect((await call(`/send?page=${page}`, { method: "POST", as: "ana" })).body.data).toMatchObject({ status: "failed" })
    expect(deliveries).toHaveLength(1)
    await reply(other.id, "bob", "Also the bus times")
    expect((await call(`/send/status?page=${page}`, { as: "ana" })).body.data.count).toBe(1)
    expect((await call(`/send/status?page=${page}`, { as: "bob" })).body.data.count).toBe(1)
  })

  it("sends others' threads as quotes, and the sender's own or last-spoken threads as asks", async () => {
    const { comment, reply, connect } = await setup()
    const own = await comment("ana", "Shorter intro")
    const answered = await comment("bob", "Which beach")
    await reply(answered.id, "ana", "Mosteiros")
    const other = await comment("bob", "Add a map")
    await connect()
    const { text } = deliveries[0]!.body
    expect(text).toContain(`Asks: ${[own.id, answered.id].sort().join(", ")}.`)
    expect(text).toContain(`Quotes: ${other.id}.`)
  })

  it("delivers ids and fixed words, never what people wrote", async () => {
    const { comment, connect, page } = await setup()
    const words = ["Furnas", "cozido", "volcanic", "kayak", "Sete", "Cidades", "lagoon"]
    await comment("ana", `${words[0]} ${words[1]} needs a ${words[2]} note`)
    await comment("bob", `${words[3]} rental near ${words[4]} ${words[5]} ${words[6]}`)
    await connect()
    const { body } = deliveries[0]!
    expect(body).toMatchObject({ event: "comments.send", page: `${origin}${page}`, count: 2, data: null, read: { url: `${origin}/_vitehub/comments/send/${body.send}` } })
    for (const word of words) expect(body.text.toLowerCase()).not.toContain(word.toLowerCase())
    for (const word of words) expect(JSON.stringify(body).toLowerCase()).not.toContain(word.toLowerCase())
  })

  it("reads exactly the threads of the send with its token, as the sender, for 24 hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { call, comment, connect, page } = await setup()
    const first = await comment("ana", "One")
    const second = await comment("bob", "Two")
    await connect()
    const { read, send } = deliveries[0]!.body
    const later = await comment("bob", "Three, after the send")
    const path = new URL(read!.url).pathname.replace("/_vitehub/comments", "")
    const opened = await call(path, { headers: { authorization: `Bearer ${read!.token}` } })
    expect(opened.status).toBe(200)
    expect(opened.body.data.send).toMatchObject({ id: send, page, state: "working" })
    expect(opened.body.data.threads.map((thread: { id: string, role: string }) => [thread.id, thread.role]).sort()).toEqual([[first.id, "ask"], [second.id, "quote"]].sort())
    expect(opened.body.data.threads.map((thread: { id: string }) => thread.id)).not.toContain(later.id)
    // The sender lost read access to the second thread, so the token no longer reads it.
    hidden.add(second.id)
    expect((await call(path, { headers: { authorization: `Bearer ${read!.token}` } })).body.data.threads.map((thread: { id: string }) => thread.id)).toEqual([first.id])
    expect((await call(path, { headers: { authorization: "Bearer vhs_wrong" } })).status).toBe(401)
    expect((await call(path)).status).toBe(401)
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000 + 1)
    expect((await call(path, { headers: { authorization: `Bearer ${read!.token}` } })).status).toBe(401)
  })

  it("limits a member to 30 sends an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const start = Date.now()
    const { call, comment, connect, page } = await setup()
    await comment("ana", "First")
    await connect()
    for (let index = 1; index < 30; index++) {
      await comment("ana", `Note ${index}`)
      expect((await call(`/send?page=${page}`, { method: "POST", as: "ana" })).body.data.status).toBe("sent")
    }
    await comment("ana", "One too many")
    const limited = (await call(`/send?page=${page}`, { method: "POST", as: "ana" })).body.data
    expect(limited).toEqual({ status: "limited", retryAt: start + 60 * 60_000 })
    expect(deliveries).toHaveLength(30)
    expect((await call(`/send/status?page=${page}`, { as: "ana" })).body.data.retryAt).toBe(start + 60 * 60_000)
    vi.setSystemTime(start + 60 * 60_000 + 1)
    expect((await call(`/send?page=${page}`, { method: "POST", as: "ana" })).body.data.status).toBe("sent")
  })

  it("is done when the sender's threads leave the waiting set", async () => {
    const { call, comments, comment, connect, page } = await setup()
    const own = await comment("ana", "Fix the date")
    await comment("bob", "Nice")
    await connect()
    expect((await call(`/send/status?page=${page}`, { as: "ana" })).body.data.working).toBeDefined()
    await comments.resolve(own.id, { by: { id: "ana" } })
    expect((await call(`/send/status?page=${page}`, { as: "ana" })).body.data.working).toBeUndefined()
  })

  it("sends no token with `grant: false`, and adds the data of `payload`", async () => {
    const { comment, connect } = await setup({ grant: false, payload: ({ asks }) => ({ drop: "2e3wx40eeskg", asks: asks.length }) })
    await comment("ana", "Hello")
    await connect()
    expect(deliveries[0]!.body).toMatchObject({ read: null, data: { drop: "2e3wx40eeskg", asks: 1 } })
    expect(deliveries[0]!.body.text).toContain("comments_get_send")
  })

  it("sends nothing to an endpoint whose host left `hosts`", async () => {
    const hosts = ["relay.t3.codes", "hooks.example.com"]
    const { call, comment, connect, page } = await setup({ hosts })
    await comment("ana", "First")
    await connect("ana", "https://hooks.example.com/t3")
    expect(deliveries).toHaveLength(1)
    // The app narrows `hosts` and deploys: the endpoint that the wider list allowed gets nothing.
    hosts.splice(1)
    await comment("ana", "Second")
    const refused = (await call(`/send?page=${page}`, { method: "POST", as: "ana" })).body.data
    expect(refused).toMatchObject({ status: "failed" })
    expect(refused.reason).toContain("is not relay.t3.codes")
    expect(deliveries).toHaveLength(1)
  })

  it("lets the member's agent read the send with comments_get_send", async () => {
    const { comments, comment, connect } = await setup()
    const thread = await comment("bob", "Swap the photos")
    await connect()
    const tool = commentsMcpTools(comments).find(candidate => candidate.name === "comments_get_send")!
    const result = await tool.call({}, { user: { id: "ana", name: "Ana", role: "editor" } })
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain(`Quote: Thread #${thread.n} ${thread.id}`)
    const other = await tool.call({ id: deliveries[0]!.body.send }, { user: { id: "bob", name: "Bob" } })
    expect(other.isError).toBe(true)
  })
})
