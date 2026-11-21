import { createServer } from "node:http"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"

import { createDrizzleWebhookEndpointStore, createDrizzleWebhookStore, webhooksTables } from "../src/database.ts"
import { createMemberEndpoint, sendToMemberEndpoint } from "../src/index.ts"
import { webhooksOperations } from "../src/operations.ts"
import { installWebhooks } from "../src/runtime.ts"

import type { Client } from "@libsql/client"
import type { Server } from "node:http"
import type { OperationContext } from "@vite-hub/internal/operations"

const secret = "whsec_member_console"
// The token stands for the T3 relay token in the URL. No operation result may hold it.
const token = "relay-token-9a4f"
// A public address in TEST-NET-3. The stubbed fetch sends its requests to the local receiver.
const publicHost = "203.0.113.10"

let server: Server
let receiverOrigin: string
let received: string[] = []
let statuses: number[] = []
let client: Client
const verifiedUsers = new Map<string, string>()

const registry = createOperationRegistry([{ operations: webhooksOperations }])
const access = { mode: "token", sections: ["webhooks"] }

/** An admin of the hosted ViteHub Console: a Console account, not an app user. */
const admin: OperationContext = { access: { ...access, via: "console" }, surface: "console", user: { id: "console_admin", name: "Admin", email: "admin@example.com" } }
/** Ana in the hosted Console, with the email of her app account. */
const anaInConsole: OperationContext = { access: { ...access, via: "console" }, surface: "console", request: new Request("https://app.example.com/_vitehub/rpc"), user: { id: "console_ana", name: "Ana", email: "Ana@Example.com", emailVerified: true } }
/** A Console account whose id equals Ana's app user id. Console ids are not app ids, so it is not Ana. */
const consoleNamedLikeAna: OperationContext = { access: { ...access, via: "console" }, surface: "console", user: { id: "user_ana", email: "mallory@example.com" } }
/** Tom as an app user, such as through the app's own MCP. */
const tomInApp: OperationContext = { access, surface: "mcp", user: { id: "user_tom", name: "Tom Becker" } }
/** `vitehub webhooks` with a key: no person. */
const cli: OperationContext = { access: { ...access, via: "cli" }, surface: "cli", user: null }

async function call<T = unknown>(context: OperationContext, name: string, input: unknown = {}) {
  const result = await runOperation(registry, name, input, context)
  // SAFETY: each test reads the output of the operation that it named.
  return result as { ok: true, value: T } | { ok: false, code: string, status: number }
}

async function value<T>(context: OperationContext, name: string, input: unknown = {}): Promise<T> {
  const result = await call<T>(context, name, input)
  if (!result.ok) throw new Error(`${name} failed: ${JSON.stringify(result)}`)
  return result.value
}

/** Every operation output, as text, must not hold the URL path, the query, the secret, or an owner's email. */
const outputs: unknown[] = []
function leakFree<T>(output: T): T {
  outputs.push(output)
  return output
}

async function connect(owner: string, ownerName: string, ownerEmail?: string) {
  const [error, endpoint] = await createMemberEndpoint({
    owner,
    ownerName,
    ...ownerEmail ? { ownerEmail } : {},
    name: "Launch plan thread",
    agent: "t3",
    kind: "url",
    url: `https://${publicHost}/hooks/${owner}?token=${token}`,
    secret,
    hosts: [publicHost],
  })
  if (error) throw error
  return endpoint
}

async function send(owner: string, key: string) {
  const [error, sent] = await sendToMemberEndpoint(owner, { threads: [key] }, { event: "comments.send", key })
  if (error) throw error
  return sent
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", chunk => chunks.push(chunk))
    request.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"))
      response.statusCode = statuses.shift() ?? 202
      response.end("ok")
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The receiver has no port.")
  receiverOrigin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
})

beforeEach(async () => {
  received = []
  statuses = []
  verifiedUsers.clear()
  verifiedUsers.set("ana@example.com", "user_ana")
  process.env.VITEHUB_WEBHOOKS_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  client = createClient({ url: ":memory:" })
  await client.executeMultiple(`${webhooksTables.join(";\n")};`)
  const realFetch = globalThis.fetch
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
    const url = new URL(input)
    return url.hostname === publicHost ? realFetch(`${receiverOrigin}${url.pathname}${url.search}`, init) : realFetch(input, init)
  })
  const db = drizzle({ client })
  // No Queue: member endpoints post in the request.
  installWebhooks({ webhooks: {}, store: createDrizzleWebhookStore(db), endpoints: createDrizzleWebhookEndpointStore(db), resolveVerifiedOwner: async email => verifiedUsers.get(email) })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.VITEHUB_WEBHOOKS_KEY
  client.close()
  const text = JSON.stringify(outputs.splice(0))
  for (const leak of [token, secret, "/hooks", "?token", "ana@example.com"]) expect(text).not.toContain(leak)
})

describe("member endpoints in the Console operations", () => {
  it("keeps delivery history when a member reconnects", async () => {
    const old = await connect("user_tom", "Tom Becker")
    const first = await send("user_tom", "first")
    const current = await connect("user_tom", "Tom Becker")
    const second = await send("user_tom", "second")
    expect(current.id).not.toBe(old.id)

    const history = await value<Array<{ id: string }>>(admin, "webhooks.deliveries", { owner: "user_tom" })
    expect(history.map(row => row.id).sort()).toEqual([first.id, second.id].sort())
    const oldHistory = await value<Array<{ id: string }>>(admin, "webhooks.deliveries", { owner: "user_tom", webhook: `@${old.id}` })
    expect(oldHistory.map(row => row.id)).toEqual([first.id])
    expect(await call(tomInApp, "webhooks.redeliver", { id: first.id })).toMatchObject({ ok: false, code: "WEBHOOKS_ENDPOINT_NOT_FOUND" })
  })

  it("lists and manages endpoints beyond the default page", async () => {
    await client.execute(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 500)
      INSERT INTO vitehub_webhook_endpoints (id, owner, name, kind, created_at, updated_at)
      SELECT 'whe_' || n, 'member_' || n, 'Inbox', 'inbox', 0, 0 FROM ids`)
    const endpoint = await connect("user_tom", "Tom Becker")
    const sent = await send("user_tom", "first")
    const first = await value<Array<{ id: string, createdAt: number }>>(cli, "webhooks.endpoints")
    expect(first).toHaveLength(500)
    const { createdAt, id } = first.at(-1)!
    const next = await value(cli, "webhooks.endpoints", { after: { createdAt, id } })
    expect(next).toEqual([expect.objectContaining({ id: endpoint.id, mine: false, last: expect.objectContaining({ status: 202 }) })])
    expect(await call(tomInApp, "webhooks.redeliver", { id: sent.id })).toMatchObject({ ok: true })
    expect(await call(admin, "webhooks.disable-endpoint", { id: endpoint.id })).toMatchObject({ ok: true })
  })

  it("requires current verified identity on both sides without reconnecting the endpoint", async () => {
    await connect("user_ana", "Ana Ruiz", "ana@example.com")
    const sent = await send("user_ana", "first")
    const unverified = { ...anaInConsole, user: { id: "console_ana", email: "ana@example.com" } }
    const mine = async (caller: OperationContext) => (await value<Array<{ mine: boolean }>>(caller, "webhooks.endpoints"))[0]?.mine
    expect(await mine(unverified)).toBe(false)
    expect(await call(unverified, "webhooks.redeliver", { id: sent.id })).toMatchObject({ ok: false, code: "WEBHOOKS_DELIVERY_NOT_OWNER" })
    expect(await mine(anaInConsole)).toBe(true)

    verifiedUsers.delete("ana@example.com")
    verifiedUsers.set("new@example.com", "user_ana")
    expect(await mine(anaInConsole)).toBe(false)
    verifiedUsers.set("ana@example.com", "user_someone_else")
    expect(await mine(anaInConsole)).toBe(false)
    for (const operation of ["webhooks.redeliver", "webhooks.flush"]) {
      expect(await call(anaInConsole, operation, { id: sent.id })).toMatchObject({ ok: false, code: "WEBHOOKS_DELIVERY_NOT_OWNER", status: 403 })
    }
    expect(received).toHaveLength(1)
    const updated = { ...anaInConsole, user: { id: "console_ana", email: "new@example.com", emailVerified: true } }
    expect(await mine(updated)).toBe(false)
    const anaInApp: OperationContext = { access, surface: "mcp", user: { id: "user_ana" } }
    expect(await mine(anaInApp)).toBe(true)
    expect(await call(anaInApp, "webhooks.redeliver", { id: sent.id })).toMatchObject({ ok: true })
    await connect("user_ana", "Ana Ruiz", "new@example.com")
    expect(await mine(updated)).toBe(true)
  })

  it("lists each endpoint with its owner, agent, host, and newest result, and marks the caller's own", async () => {
    const ana = await connect("user_ana", "Ana Ruiz", "Ana@Example.com")
    const tom = await connect("user_tom", "Tom Becker")
    expect((await send("user_ana", "thr_1")).status).toBe("sent")
    statuses.push(401)
    expect((await send("user_tom", "thr_2")).status).toBe("failed")

    const rows = leakFree(await value<Array<Record<string, unknown>>>(admin, "webhooks.endpoints"))
    expect(rows).toEqual([
      expect.objectContaining({ id: ana.id, owner: "user_ana", ownerName: "Ana Ruiz", agent: "t3", kind: "url", host: publicHost, disabledAt: null, mine: false, last: expect.objectContaining({ state: "sent", status: 202, failures: 0 }) }),
      expect.objectContaining({ id: tom.id, owner: "user_tom", ownerName: "Tom Becker", mine: false, last: expect.objectContaining({ state: "dead", status: 401, failures: 1 }) }),
    ])
    expect(rows[0]).not.toHaveProperty("ownerEmail")
    expect(rows[0]).not.toHaveProperty("sealed")

    const mine = leakFree(await value<Array<{ owner: string, mine: boolean }>>(anaInConsole, "webhooks.endpoints"))
    expect(mine.map(row => [row.owner, row.mine])).toEqual([["user_ana", true], ["user_tom", false]])
    const tomMine = leakFree(await value<Array<{ owner: string, mine: boolean }>>(tomInApp, "webhooks.endpoints"))
    expect(tomMine.map(row => [row.owner, row.mine])).toEqual([["user_ana", false], ["user_tom", true]])

    // The log filters by owner: the deliveries of that member's endpoint.
    const anaLog = leakFree(await value<Array<{ webhook: string }>>(admin, "webhooks.deliveries", { owner: "user_ana" }))
    expect(anaLog.map(entry => entry.webhook)).toEqual([`@${ana.id}`])
    expect(leakFree(await value(admin, "webhooks.deliveries", { owner: "user_nobody" }))).toEqual([])
    expect(leakFree(await value(admin, "webhooks.deliveries", { owner: "user_ana", webhook: `@${tom.id}` }))).toEqual([])
  })

  it("redelivers a member delivery only for its owner, and refuses everyone else with 403", async () => {
    await connect("user_ana", "Ana Ruiz", "ana@example.com")
    await connect("user_tom", "Tom Becker")
    const anaSend = await send("user_ana", "thr_1")
    statuses.push(401)
    const tomSend = await send("user_tom", "thr_2")
    expect(received).toHaveLength(2)

    for (const [caller, id] of [[admin, tomSend.id], [cli, tomSend.id], [anaInConsole, tomSend.id], [consoleNamedLikeAna, anaSend.id], [tomInApp, anaSend.id]] as const) {
      expect(await call(caller, "webhooks.redeliver", { id })).toMatchObject({ ok: false, code: "WEBHOOKS_DELIVERY_NOT_OWNER", status: 403 })
    }
    expect(received).toHaveLength(2)

    // Tom's own app account, and Ana's Console account with her verified app email.
    const again = leakFree(await value<{ id: string, status: string }>(tomInApp, "webhooks.redeliver", { id: tomSend.id }))
    expect(again).toEqual({ id: expect.stringMatching(/^whd_/), status: "sent" })
    expect(leakFree(await value(anaInConsole, "webhooks.redeliver", { id: anaSend.id }))).toMatchObject({ status: "sent" })
    expect(received.slice(2).map(body => JSON.parse(body))).toEqual([{ threads: ["thr_2"] }, { threads: ["thr_1"] }])
    expect(leakFree(await value(admin, "webhooks.get", { id: again.id }))).toMatchObject({ state: "sent", lastStatus: 202 })
  })

  it("stops delivery while an admin has the endpoint disabled, and starts it again on Enable", async () => {
    const ana = await connect("user_ana", "Ana Ruiz", "ana@example.com")
    const first = await send("user_ana", "thr_1")

    expect(leakFree(await value(admin, "webhooks.disable-endpoint", { id: ana.id }))).toEqual({ id: ana.id, owner: "user_ana", disabledAt: expect.any(Number), disabledBy: "Admin" })
    expect(await sendToMemberEndpoint("user_ana", { threads: ["thr_2"] }, { event: "comments.send", key: "thr_2" })).toMatchObject([{ code: "WEBHOOKS_ENDPOINT_DISABLED" }, undefined])
    expect(await call(anaInConsole, "webhooks.redeliver", { id: first.id })).toMatchObject({ ok: false, code: "WEBHOOKS_ENDPOINT_DISABLED", status: 409 })
    expect(received).toHaveLength(1)
    const [row] = leakFree(await value<Array<{ disabledAt: number | null, disabledBy: string | null }>>(admin, "webhooks.endpoints"))
    expect(row).toMatchObject({ disabledAt: expect.any(Number), disabledBy: "Admin" })

    expect(leakFree(await value(admin, "webhooks.enable-endpoint", { id: ana.id }))).toEqual({ id: ana.id, owner: "user_ana", disabledAt: null, disabledBy: null })
    expect((await send("user_ana", "thr_2")).status).toBe("sent")
    expect(received).toHaveLength(2)
    expect(await call(admin, "webhooks.disable-endpoint", { id: "whe_missing" })).toMatchObject({ ok: false, code: "WEBHOOKS_ENDPOINT_NOT_FOUND", status: 404 })
  })

  it("lets a read-only grant list the endpoints and nothing else", async () => {
    const ana = await connect("user_ana", "Ana Ruiz")
    const reader: OperationContext = { access: { mode: "token", sections: ["webhooks:read"], via: "console" }, surface: "mcp", user: admin.user }
    expect(await call(reader, "webhooks.endpoints")).toMatchObject({ ok: true })
    for (const name of ["webhooks.disable-endpoint", "webhooks.enable-endpoint"]) {
      expect(await call(reader, name, { id: ana.id })).toMatchObject({ ok: false, code: "INTERNAL_R0023", status: 403 })
    }
  })
})
