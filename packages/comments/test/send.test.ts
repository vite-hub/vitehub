import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { H3 } from "h3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDrizzleWebhookEndpointStore, createDrizzleWebhookStore, webhooksTables } from "../../webhooks/src/database.ts"
import { createMemberEndpoint, getMemberEndpoint, listMemberDeliveries } from "../../webhooks/src/index.ts"
import { deliverWebhookWake, getWebhookDelivery, installWebhooks, listWebhookDeliveries, redeliverWebhookDelivery } from "../../webhooks/src/runtime.ts"
import { defineComments } from "../src/index.ts"
import { installComments } from "../src/install.ts"
import { createCommentsHandler } from "../src/runtime/handler.ts"
import { commentsMcpTools } from "../src/runtime/mcp.ts"
import { commentSendsTables } from "../src/send/database.ts"
import { commentsMigration } from "./harness.ts"

import type { CommentsDatabase } from "../src/operations-core/store.ts"
import type { CommentsUser, CommentThread, DefineCommentsOptions } from "../src/types.ts"
import type { WebhookWakeSender } from "../../webhooks/src/runtime.ts"

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

const httpsRequest = vi.hoisted(() => vi.fn())
vi.mock("node:https", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:https")>(),
  request: httpsRequest,
}))

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
let receiverStatus = 202
/** Threads that the policy hides from everyone, to check that a token reads as the sender now. */
let hidden = new Set<string>()

async function setup(send: DefineCommentsOptions["send"] = true, wake?: WebhookWakeSender) {
  const client = createClient({ url: ":memory:" })
  await client.executeMultiple([commentsMigration, ...commentSendsTables.map(statement => `${statement};`), ...webhooksTables.map(statement => `${statement};`)].join("\n"))
  // SAFETY: The libSQL Drizzle database implements the batch contract that ViteHub Databases expose.
  const database = drizzle({ client }) as unknown as CommentsDatabase
  const db = drizzle({ client })
  const store = createDrizzleWebhookStore(db)
  const endpoints = createDrizzleWebhookEndpointStore(db)
  installWebhooks({ webhooks: {}, store, endpoints, ...(wake ? { wake } : {}) })
  const comments = defineComments({
    identify: ({ event }) => people[event["~standard"].req.headers.get("x-test-user") ?? ""] ?? null,
    authorize: ({ thread, user, console }) => !thread || (!hidden.has(thread.id) && (user?.role !== "viewer" || console === true)),
    send,
  })
  installComments(comments, { database, webhooks: () => import("../../webhooks/src/index.ts") })
  const app = new H3().all("/_vitehub/comments/**", createCommentsHandler({ comments, realtime: false }))
  /** `base` is the origin that the server sees in the request URL. The `origin` header defaults to it. */
  const call = async (path: string, init: { method?: string, as?: keyof typeof people, json?: unknown, origin?: string | null, base?: string, headers?: Record<string, string> } = {}) => {
    const base = init.base ?? origin
    const headers = new Headers(init.headers)
    if (init.as) headers.set("x-test-user", init.as)
    if (init.json !== undefined) headers.set("content-type", "application/json")
    const method = init.method ?? (init.json === undefined ? "GET" : "POST")
    if (method !== "GET" && init.origin !== null) headers.set("origin", init.origin ?? base)
    const response = await app.fetch(new Request(`${base}/_vitehub/comments${path}`, { method, headers, ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }) }))
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
    return { code, allowed: await call(`/send/allow?page=${page}`, { json: { code, selection: started.body.data.selection }, as }) }
  }
  return { comments, call, comment, reply, connect, page, store, endpoints }
}

beforeEach(() => {
  deliveries = []
  receiverStatus = 202
  hidden = new Set()
  vi.stubEnv("VITEHUB_WEBHOOKS_KEY", btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))
  httpsRequest.mockReset()
  httpsRequest.mockImplementation((url: URL, options: { headers: Record<string, string> }, onResponse: (response: { statusCode: number, destroy: () => void }) => void) => ({
    on: vi.fn(),
    end: (body: string) => {
      deliveries.push({ url: url.href, headers: new Headers(options.headers), body: JSON.parse(body) })
      onResponse({ statusCode: receiverStatus, destroy: vi.fn() })
    },
  }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
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
    const stolen = await call(`/send/allow?page=${page}`, { json: { code, selection: body.data.selection }, as: "bob" })
    expect(stolen.status).toBe(403)
    expect(await getMemberEndpoint("bob")).toEqual([undefined, null])
    expect(deliveries).toHaveLength(0)
    expect((await call(`/send/pair/${code}`, { as: "ana" })).body.data.status).toBe("paired")
    const allowed = await call(`/send/allow?page=${page}`, { json: { code, selection: body.data.selection }, as: "ana" })
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

describe("origin", () => {
  it("refuses Start, Allow, and Send over plain http, and names the origin", async () => {
    const { call, comment, page } = await setup()
    await comment("ana", "The rental desk paragraph is too long")
    const base = "http://notes.test"
    for (const [path, json] of [[`/send/start?page=${page}`, {}], [`/send/allow?page=${page}`, { code: "K7QM-4XPA-9RTC" }], [`/send?page=${page}`, {}]] as const) {
      const refused = await call(path, { json, as: "ana", base })
      expect(refused.status, path).toBe(403)
      expect(refused.body.error?.code, path).toBe("COMMENTS_SEND_INSECURE")
      expect(refused.body.error?.why, path).toContain(base)
      expect(JSON.stringify(refused.body), path).not.toMatch(/whsec_|vhs_/)
    }
    expect(deliveries).toHaveLength(0)
  })

  it("rejects malformed pair posts over plain http without consuming the code", async () => {
    const { call, page } = await setup()
    const started = await call(`/send/start?page=${page}`, { method: "POST", as: "ana" })
    const code: string = started.body.data.code
    for (const json of [{ code }, { code, url: relay, inbox: "Codex" }, { url: relay }, { code: "A".repeat(65), url: relay }]) {
      const invalid = await call("/send/pair", { json, origin: null, base: "http://notes.test" })
      expect(invalid).toMatchObject({ status: 400, body: { reason: "invalid", error: { code: "COMMENTS_INVALID_INPUT" } } })
    }
    expect((await call(`/send/pair/${code}`, { as: "ana" })).body.data).toEqual({ status: "waiting" })
  })

  it("refuses a pair post over plain http, and refuses its code for good", async () => {
    const { call, page } = await setup()
    const { body } = await call(`/send/start?page=${page}`, { method: "POST", as: "ana" })
    const code = body.data.code
    const insecure = await call("/send/pair", { json: { code, url: relay }, origin: null, base: "http://notes.test" })
    expect(insecure).toMatchObject({ status: 403, body: { reason: "insecure", error: { code: "COMMENTS_SEND_INSECURE" } } })
    expect((await call(`/send/pair/${code}`, { as: "ana" })).body.data).toEqual({ status: "refused" })
    expect((await call("/send/pair", { json: { code, url: relay }, origin: null })).status).toBe(409)
    expect(await getMemberEndpoint("ana")).toEqual([undefined, null])
  })

  it.each(["http://localhost:3000", "http://127.0.0.1:8787", "http://app.localhost"])("pairs and sends over %s", async (base) => {
    const { call, comment, page } = await setup()
    await comment("ana", "The rental desk paragraph is too long")
    const started = await call(`/send/start?page=${page}`, { method: "POST", as: "ana", base })
    expect(started.status).toBe(200)
    expect(started.body.data.prompt).toContain(`${base}/_vitehub/comments/send/pair`)
    const code = started.body.data.code
    expect((await call("/send/pair", { json: { code, url: relay }, origin: null, base })).status).toBe(200)
    expect((await call(`/send/allow?page=${page}`, { json: { code, selection: started.body.data.selection }, as: "ana", base })).body.data).toMatchObject({ status: "sent" })
    expect(deliveries[0]!.body.read!.url.startsWith(`${base}/_vitehub/comments/send/`)).toBe(true)
  })

  it("takes https from x-forwarded-proto behind a proxy", async () => {
    const { call, page } = await setup()
    const proxied = { base: "http://notes.test", origin: "https://notes.test", headers: { "x-forwarded-proto": "https" } }
    const started = await call(`/send/start?page=${page}`, { method: "POST", as: "ana", ...proxied })
    expect(started.status).toBe(200)
    expect(started.body.data.prompt).toContain("https://notes.test/_vitehub/comments/send/pair")
  })
})

describe("sends", () => {
  it("counts the threads that wait, from everyone, and not the ones already sent", async () => {
    const { call, comment, reply, connect, page } = await setup()
    const own = await comment("ana", "Move the cozido note up")
    const other = await comment("bob", "Is the ferry still running in May")
    expect((await call(`/send/status?page=${page}`, { as: "ana" })).body.data).toEqual({ count: 2, selection: expect.stringMatching(/^[0-9a-f]{64}$/) })
    await connect()
    expect(deliveries[0]!.body.threads.sort()).toEqual([own.id, other.id].sort())
    const after = (await call(`/send/status?page=${page}`, { as: "ana" })).body.data
    expect(after).toMatchObject({ count: 0, agent: { name: "T3 Code", host: "relay.t3.codes" }, working: { id: deliveries[0]!.body.send } })
    expect((await call(`/send?page=${page}`, { method: "POST", as: "ana" })).body.data).toMatchObject({ status: "sent", id: deliveries[0]!.body.send })
    expect(deliveries).toHaveLength(1)
    await reply(other.id, "bob", "Also the bus times")
    expect((await call(`/send/status?page=${page}`, { as: "ana" })).body.data.count).toBe(1)
    // Ana's send does not count for Bob: both threads still wait for his agent.
    expect((await call(`/send/status?page=${page}`, { as: "bob" })).body.data.count).toBe(2)
  })

  it("keeps a thread waiting for a member after another member sent it", async () => {
    const { call, comment, connect, page } = await setup()
    const thread = await comment("cora", "Is the ferry still running in May")
    await connect("ana")
    expect((await call(`/send/status?page=${page}`, { as: "ana" })).body.data.count).toBe(0)
    expect((await call(`/send/status?page=${page}`, { as: "bob" })).body.data.count).toBe(1)
    const { allowed } = await connect("bob")
    expect(allowed.body.data.status).toBe("sent")
    expect(deliveries.map(delivery => delivery.body.threads)).toEqual([[thread.id], [thread.id]])
  })

  it("counts a new message whose time is before the send, as from a server with a slower clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { call, comment, reply, connect, page } = await setup()
    const thread = await comment("ana", "Move the cozido note up")
    const commented = Date.now()
    vi.setSystemTime(commented + 5000)
    await connect()
    // A server whose clock is 5 seconds slow stores a reply. Its time is before the send, which did not carry it.
    vi.setSystemTime(commented)
    await reply(thread.id, "bob", "And the ferry times")
    expect((await call(`/send/status?page=${page}`, { as: "ana" })).body.data.count).toBe(1)
    expect((await call(`/send?page=${page}`, { method: "POST", as: "ana" })).body.data.status).toBe("sent")
    expect(deliveries).toHaveLength(2)
  })

  it("allows only the threads that the member saw, and keeps the code when they changed", async () => {
    const { call, comment, page } = await setup()
    const first = await comment("ana", "Shorter intro")
    const started = await call(`/send/start?page=${page}`, { method: "POST", as: "ana" })
    expect(started.body.data).toMatchObject({ count: 1, selection: expect.stringMatching(/^[0-9a-f]{64}$/) })
    const code: string = started.body.data.code
    await call("/send/pair", { json: { code, url: relay }, origin: null })
    const second = await comment("bob", "Add a map")
    const changed = (await call(`/send/allow?page=${page}`, { json: { code, selection: started.body.data.selection }, as: "ana" })).body.data
    expect(changed).toEqual({ status: "changed", count: 2, selection: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(changed.selection).not.toBe(started.body.data.selection)
    expect((await call(`/send/allow?page=${page}`, { json: { code }, as: "ana" })).body.data).toEqual(changed)
    expect(deliveries).toHaveLength(0)
    expect(await getMemberEndpoint("ana")).toEqual([undefined, null])
    const allowed = await call(`/send/allow?page=${page}`, { json: { code, selection: changed.selection }, as: "ana" })
    expect(allowed.body.data.status).toBe("sent")
    expect(deliveries[0]!.body.threads.sort()).toEqual([first.id, second.id].sort())
  })

  it("does not consume a waiting code if the agent pairs during Allow", async () => {
    const { call, comment, endpoints, page } = await setup()
    await comment("ana", "Shorter intro")
    const started = await call(`/send/start?page=${page}`, { method: "POST", as: "ana" })
    const { code, selection } = started.body.data
    await comment("bob", "Add a map")
    const pairing = endpoints.pairing.bind(endpoints)
    const lookup = vi.spyOn(endpoints, "pairing").mockImplementationOnce(async (id) => {
      const waiting = await pairing(id)
      expect(waiting?.state).toBe("waiting")
      expect((await call("/send/pair", { json: { code, url: relay }, origin: null })).status).toBe(200)
      return waiting
    })
    const allow = () => call(`/send/allow?page=${page}`, { json: { code, selection }, as: "ana" })
    try {
      expect((await allow()).status).toBe(410)
    }
    finally {
      lookup.mockRestore()
    }
    expect((await allow()).body.data).toMatchObject({ status: "changed", count: 2 })
    expect(await getMemberEndpoint("ana")).toEqual([undefined, null])
    expect(deliveries).toHaveLength(0)
  })

  it("starts the setup prompt from `send.prompt`", async () => {
    const { call, page } = await setup({ prompt: ({ code, pairUrl, user, subject, prompt }) => `Inbox for ${user.id} on ${subject.id}: ${pairUrl} ${code}\n\n${prompt}` })
    const { body } = await call(`/send/start?page=${page}`, { method: "POST", as: "ana" })
    const prompt: string = body.data.prompt
    expect(prompt.startsWith(`Inbox for ana on ${page}: ${origin}/_vitehub/comments/send/pair ${body.data.code}\n\n`)).toBe(true)
    expect(prompt).toContain("schedule_task")
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

  it("sends to the agent paired from `send.address`, and else to the one paired last", async () => {
    const otherThread = "t3-thread://v2/6f5c40a4-eb77-4249-a83a-c0d4f680b208/mcp:other:0c9f"
    let address: string | null = threadLink
    const { call, comment, connect, page } = await setup({ hosts: ["relay.t3.codes", "hooks.example.com"], address: () => address })
    const sentTo = () => new URL(deliveries.at(-1)!.url).pathname
    await comment("ana", "First")
    await connect("ana", "https://hooks.example.com/a", threadLink)
    expect(sentTo()).toBe("/a")
    await comment("ana", "Second")
    await connect("ana", "https://hooks.example.com/b", otherThread)
    // Allow sends to the agent it just paired, whatever `send.address` says.
    expect(sentTo()).toBe("/b")

    await comment("ana", "Third")
    expect((await call(`/send?page=${page}`, { json: {}, as: "ana" })).body.data).toMatchObject({ status: "sent", thread: threadLink })
    expect(sentTo()).toBe("/a")

    address = "t3-thread://v2/6f5c40a4-eb77-4249-a83a-c0d4f680b208/mcp:gone:1a2b"
    await comment("ana", "Fourth")
    expect((await call(`/send?page=${page}`, { json: {}, as: "ana" })).body.data).toMatchObject({ status: "sent", thread: otherThread })
    expect(sentTo()).toBe("/b")
    expect(deliveries).toHaveLength(4)
  })

  it("keeps Allow on the newly paired endpoint when another pairing arrives during payload", async () => {
    const { comment, connect } = await setup({
      payload: async () => {
        vi.setSystemTime(Date.now() + 1)
        const [error] = await createMemberEndpoint({ owner: "ana", name: "Another inbox", address: threadLink, kind: "inbox" })
        if (error) throw error
        return null
      },
    })
    vi.useFakeTimers({ toFake: ["Date"] })
    await comment("ana", "Send this to the paired URL")
    const { allowed } = await connect()
    expect(allowed.body.data).toMatchObject({ status: "sent" })
    expect(deliveries).toHaveLength(1)
    expect((await listMemberDeliveries("ana", { address: threadLink }))[1]?.deliveries).toEqual([])
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

  it("seals the delivery body at rest and can redeliver it without exposing the grant", async () => {
    const { comment, connect, store } = await setup()
    await comment("ana", "Hello")
    await connect()
    const id = deliveries[0]!.headers.get("x-vitehub-delivery")!
    const token = deliveries[0]!.body.read!.token
    expect(JSON.stringify(await store.get(id))).not.toContain(token)
    expect((await getWebhookDelivery(id))[1]?.body).toBeNull()
    expect((await listWebhookDeliveries())[1]?.[0]?.body).toBeNull()
    expect((await listWebhookDeliveries({ owner: "ana" }))[1]?.[0]).toMatchObject({ id, body: null })
    expect((await listMemberDeliveries("ana"))[1]?.deliveries[0]).toMatchObject({ id, body: null })
    expect((await redeliverWebhookDelivery(id, { caller: { id: "ana" } }))[0]).toBeUndefined()
    expect(deliveries[1]!.body.read!.token).toBe(token)
  })

  it("checks the current MCP identity and finishes an ask when the agent replies with its send ID", async () => {
    const { comments, call, comment, page } = await setup({ grant: false })
    const ask = await comment("ana", "Please update the notes")
    const started = await call(`/send/start?page=${page}`, { method: "POST", as: "ana" })
    const code: string = started.body.data.code
    await call("/send/pair", { json: { code, inbox: "Codex" }, origin: null })
    const allowed = await call(`/send/allow?page=${page}`, { json: { code, selection: started.body.data.selection }, as: "ana" })
    const id: string = allowed.body.data.id
    const tools = commentsMcpTools(comments)
    const read = tools.find(tool => tool.name === "comments_get_send")!
    const replyTool = tools.find(tool => tool.name === "comments_reply")!
    expect((await read.call({ id }, { user: { id: "ana", role: "viewer" } })).text).not.toContain(ask.id)
    const consoleRead = commentsMcpTools(comments, { console: true }).find(tool => tool.name === "comments_get_send")!
    expect((await consoleRead.call({ id }, { user: { id: "ana", role: "viewer" } })).text).toContain(ask.id)
    const editor = { user: { id: "ana", role: "editor" } }
    expect((await read.call({ id }, editor)).text).toContain(ask.id)
    expect((await replyTool.call({ id: ask.id, send: id, body: "Updated the notes." }, editor)).isError).toBeUndefined()
    expect((await call(`/send/status?page=${page}`, { as: "ana" })).body.data).toMatchObject({ count: 0 })
    expect((await call(`/send/status?page=${page}`, { as: "ana" })).body.data.working).toBeUndefined()
  })

  it("keeps a batch retryable when preparing the payload fails", async () => {
    const payload = vi.fn().mockRejectedValueOnce(new Error("prepare failed")).mockResolvedValue(null)
    const { call, comment, connect, page } = await setup({ payload })
    await comment("ana", "Hello")
    expect((await connect()).allowed.body.data.status).toBe("failed")
    expect(deliveries).toHaveLength(0)
    expect((await call(`/send/status?page=${page}`, { as: "ana" })).body.data.count).toBe(1)
    expect((await call(`/send?page=${page}`, { method: "POST", as: "ana" })).body.data.status).toBe("sent")
    expect(deliveries).toHaveLength(1)
  })

  it("claims just one send and payload for concurrent requests", async () => {
    const payload = vi.fn(() => null)
    const { call, comment, connect, page } = await setup({ payload })
    await comment("ana", "First batch")
    await connect()
    await comment("ana", "Next batch")
    const results = await Promise.all(Array.from({ length: 5 }, () => call(`/send?page=${page}`, { method: "POST", as: "ana" })))
    expect(payload).toHaveBeenCalledTimes(2)
    expect(deliveries).toHaveLength(2)
    expect(results.map(result => result.body.data.id)).toEqual(Array.from({ length: 5 }, () => deliveries[1]!.body.send))
  })

  it("shares an in-flight send and makes its batch retryable after the Queue marks it dead", async () => {
    const jobs: unknown[] = []
    const { call, comment, connect, page, store } = await setup(true, async (job) => {
      jobs.push(job)
      return [undefined, undefined]
    })
    await comment("ana", "Hello")
    receiverStatus = 503
    const { allowed } = await connect()
    const send = allowed.body.data
    expect(send.status).toBe("pending")
    const again = await call(`/send?page=${page}`, { method: "POST", as: "ana" })
    expect(again.body.data).toEqual(send)
    expect(deliveries).toHaveLength(1)
    expect((await call(`/send/status?page=${page}`, { as: "ana" })).body.data).toMatchObject({ count: 1, pending: true })
    expect(jobs).toHaveLength(1)
    for (let attempt = 0; attempt < 2; attempt++) await expect(deliverWebhookWake(jobs[0])).rejects.toMatchObject({ code: "WEBHOOKS_DELIVERY_FAILED" })
    await deliverWebhookWake(jobs[0])
    expect((await store.get(deliveries[0]!.headers.get("x-vitehub-delivery")!))?.state).toBe("dead")
    const status = (await call(`/send/status?page=${page}`, { as: "ana" })).body.data
    expect(status.count).toBe(1)
    expect(status.working).toBeUndefined()
    expect(status.pending).toBeUndefined()
    receiverStatus = 202
    const retried = (await call(`/send?page=${page}`, { method: "POST", as: "ana" })).body.data
    expect(retried.status).toBe("sent")
    expect(retried.id).not.toBe(send.id)
  })
})

describe("the server API of Send", () => {
  it("lists a send after a successful Queue retry without waiting for a status request", async () => {
    const jobs: unknown[] = []
    const { comments, comment, connect } = await setup(true, async (job) => {
      jobs.push(job)
      return [undefined, undefined]
    })
    await comment("ana", "Hello")
    receiverStatus = 503
    const { allowed } = await connect()
    expect(allowed.body.data.status).toBe("pending")
    expect(await comments.listSends(people.ana!)).toEqual([undefined, []])
    expect(jobs).toHaveLength(1)
    receiverStatus = 202
    await deliverWebhookWake(jobs[0])
    expect((await comments.listSends(people.ana!))[1]?.map(view => view.send)).toMatchObject([{ id: allowed.body.data.id, state: "sent" }])
  })

  it("fills the list limit with readable sends", async () => {
    const { call, comments, comment, connect, page } = await setup()
    const clock = vi.spyOn(Date, "now")
    const now = Date.now()
    try {
      clock.mockReturnValue(now)
      await comment("ana", "First batch")
      await connect()
      clock.mockReturnValue(now + 1)
      const newest = await comment("ana", "Next batch")
      const response = await call(`/send?page=${page}`, { method: "POST", as: "ana" })
      expect(response.body.data.status).toBe("sent")
      expect((await comments.listSends(people.ana!, { limit: 1 }))[1]?.map(view => view.send.id)).toEqual([deliveries[1]!.body.send])
      hidden.add(newest.id)
      expect((await comments.listSends(people.ana!, { limit: 1 }))[1]?.map(view => view.send.id)).toEqual([deliveries[0]!.body.send])
    }
    finally {
      clock.mockRestore()
    }
  })

  it("lists the member's sends with the threads they may read, and marks done the finished ones", async () => {
    const { comments, comment, connect } = await setup()
    const own = await comment("ana", "Fix the date")
    const other = await comment("bob", "Add a map")
    await connect()
    const id = deliveries[0]!.body.send
    const [, listed] = await comments.listSends(people.ana!)
    expect(listed!.map(view => view.send)).toMatchObject([{ id, state: "sent" }])
    expect(listed![0]!.threads.map(thread => [thread.id, thread.role]).sort()).toEqual([[own.id, "ask"], [other.id, "quote"]].sort())
    hidden.add(other.id)
    expect((await comments.listSends(people.ana!))[1]![0]!.threads.map(thread => thread.id)).toEqual([own.id])
    expect(await comments.listSends(people.bob!)).toEqual([undefined, []])
    expect((await comments.readSend(people.ana!, id))[1]!.send.state).toBe("working")
    expect((await comments.readSend(people.bob!, id))[0]?.code).toBe("COMMENTS_NOT_FOUND")
    await comments.resolve(own.id, { by: { id: "ana" } })
    expect(await comments.listSends(people.ana!)).toEqual([undefined, []])
    expect((await comments.listSends(people.ana!, { states: ["done"] }))[1]!.map(view => view.send.id)).toEqual([id])
  })

  it("answers COMMENTS_SEND_OFF without `send`", async () => {
    const { comments } = await setup(false)
    expect((await comments.listSends(people.ana!))[0]?.code).toBe("COMMENTS_SEND_OFF")
    expect((await comments.readSend(people.ana!, "send_1"))[0]?.code).toBe("COMMENTS_SEND_OFF")
  })

  it("puts an inbox send back when its thread opens again, from the server API and the REST route", async () => {
    const { call, comments, comment, page } = await setup()
    const own = await comment("ana", "Fix the date")
    const quote = await comment("bob", "Add a map")
    const started = await call(`/send/start?page=${page}`, { method: "POST", as: "ana" })
    const { code, selection } = started.body.data
    await call("/send/pair", { json: { code, inbox: "Codex" }, origin: null })
    const allowed = await call(`/send/allow?page=${page}`, { json: { code, selection }, as: "ana" })
    expect(allowed.body.data.status).toBe("sent")
    const id = allowed.body.data.id
    const status = async () => (await call(`/send/status?page=${page}`, { as: "ana" })).body.data
    await comments.resolve(own.id, { by: { id: "ana" } })
    expect((await status()).working).toBeUndefined()
    await comments.reopen(own.id)
    expect(await status()).toMatchObject({ count: 0, working: { id } })

    await comments.resolve(own.id, { by: { id: "ana" } })
    expect((await status()).working).toBeUndefined()
    expect((await call(`/threads/${own.id}/reopen`, { method: "POST", as: "ana" })).status).toBe(200)
    expect(await status()).toMatchObject({ count: 0, working: { id } })

    // A quote does not bring back a send that has asks.
    await comments.resolve(own.id, { by: { id: "ana" } })
    await comments.resolve(quote.id, { by: { id: "ana" } })
    await comments.reopen(quote.id)
    expect((await status()).working).toBeUndefined()
  })

  it("lets the member send a reopened ask to the webhook again without resending its quote", async () => {
    const { call, comments, comment, connect, page } = await setup()
    const own = await comment("ana", "Fix the date")
    await comment("bob", "Add a map")
    await connect()
    const status = async () => (await call(`/send/status?page=${page}`, { as: "ana" })).body.data
    for (let round = 0; round < 2; round++) {
      await comments.resolve(own.id, { by: { id: "ana" } })
      expect((await status()).working).toBeUndefined()
      await comments.reopen(own.id)
      expect((await status()).count).toBe(1)
      expect((await status()).working).toBeUndefined()
      expect(deliveries).toHaveLength(round + 1)
      const result = await call(`/send?page=${page}`, { method: "POST", as: "ana" })
      expect(result.body.data.status).toBe("sent")
      expect(deliveries).toHaveLength(round + 2)
      expect(deliveries.at(-1)!.body.threads).toEqual([own.id])
      expect((await status()).count).toBe(0)
    }
    expect(new Set(deliveries.map(delivery => delivery.body.send)).size).toBe(3)
  })
})
