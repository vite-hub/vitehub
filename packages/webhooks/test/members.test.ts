import { createServer } from "node:http"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { verifyWebhook } from "@vite-hub/env"

import { createDrizzleWebhookEndpointStore, createDrizzleWebhookStore, webhooksTables } from "../src/database.ts"
import { checkWebhookUrl, createMemberEndpoint, disableMemberEndpoint, getMemberEndpoint, removeMemberEndpoint, sendToMemberEndpoint } from "../src/index.ts"
import { deliverWebhookWake, getWebhookDelivery, installWebhooks, listWebhookDeliveries } from "../src/runtime.ts"

import type { Client } from "@libsql/client"
import type { IncomingHttpHeaders, Server } from "node:http"
import type { WebhookWake } from "../src/runtime.ts"

// Names that the guard resolves. A real lookup would make the test depend on the network.
vi.mock("node:dns/promises", () => {
  const records: Record<string, string[]> = {
    "relay.t3.codes": ["104.21.3.218", "2606:4700:3035::ac43:999b"],
    "intranet.example.com": ["10.0.0.7"],
    "rebind.example.com": ["93.184.215.14", "127.0.0.1"],
    "metadata.example.com": ["::ffff:169.254.169.254"],
  }
  const lookup = async (host: string) => {
    const addresses = records[host]
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" })
    return addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 }))
  }
  return { lookup, default: { lookup } }
})

interface Received {
  headers: IncomingHttpHeaders
  body: string
  url: string
}

const secret = "whsec_member_secret"
// The token stands for the T3 relay token in the URL. No stored row may hold it.
const token = "relay-token-7c1d"
// A public address in TEST-NET-3. The stubbed fetch sends its requests to the local receiver.
const publicHost = "203.0.113.10"
const endpointUrl = `https://${publicHost}/hooks/abc?token=${token}`

let server: Server
let receiverOrigin: string
let received: Received[] = []
let statuses: number[] = []
let client: Client
let wakes: Array<{ wake: WebhookWake, delay: unknown }> = []

function install(options: { queue?: boolean } = {}) {
  const db = drizzle({ client })
  installWebhooks({
    webhooks: {},
    store: createDrizzleWebhookStore(db),
    endpoints: createDrizzleWebhookEndpointStore(db),
    ...options.queue
      ? { wake: async (wake: WebhookWake, wakeOptions: { delay: unknown }) => {
          wakes.push({ wake, delay: wakeOptions.delay })
          return [undefined, undefined] as const
        } }
      : {},
  })
}

async function connect(owner = "user_ana") {
  const [error, endpoint] = await createMemberEndpoint({ owner, name: "Launch plan thread", agent: "t3", kind: "url", url: endpointUrl, secret, hosts: [publicHost] })
  if (error) throw error
  return endpoint
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", chunk => chunks.push(chunk))
    request.on("end", () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8"), url: request.url ?? "" })
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
  wakes = []
  process.env.VITEHUB_WEBHOOKS_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  client = createClient({ url: ":memory:" })
  await client.executeMultiple(`${webhooksTables.join(";\n")};`)
  const realFetch = globalThis.fetch
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
    const url = new URL(input)
    return url.hostname === publicHost ? realFetch(`${receiverOrigin}${url.pathname}${url.search}`, init) : realFetch(input, init)
  })
  install()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.VITEHUB_WEBHOOKS_KEY
  client.close()
})

describe("checkWebhookUrl", () => {
  it("refuses loopback, private, link-local, and metadata addresses", async () => {
    for (const url of [
      "https://127.0.0.1/hook",
      "https://10.0.0.1/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[fd00::1]/hook",
      "https://[fe80::1]/hook",
      "https://2130706433/hook",
      "https://localhost/hook",
      "https://100.100.100.200/hook",
    ]) {
      const [error] = await checkWebhookUrl(url)
      expect(error, url).toMatchObject({ code: "WEBHOOKS_URL_REFUSED" })
    }
  })

  it("refuses a name that resolves to a private address", async () => {
    expect((await checkWebhookUrl("https://intranet.example.com/hook"))[0]?.message).toContain("resolves to a private address")
    // One private address among public ones is enough to refuse.
    expect((await checkWebhookUrl("https://rebind.example.com/hook"))[0]?.message).toContain("resolves to a loopback address")
    expect((await checkWebhookUrl("https://metadata.example.com/hook"))[0]?.message).toContain("metadata")
    expect((await checkWebhookUrl("https://missing.example.com/hook"))[0]?.message).toContain("does not resolve")
  })

  it("refuses http, credentials in the URL, and a host outside the allowlist", async () => {
    expect((await checkWebhookUrl("http://relay.t3.codes/hook"))[0]?.message).toContain("does not use https")
    expect((await checkWebhookUrl("https://user:pass@relay.t3.codes/hook"))[0]?.message).toContain("user name or a password")
    expect((await checkWebhookUrl("https://evil.example.com/hook", { hosts: ["relay.t3.codes"] }))[0]?.message).toContain("is not relay.t3.codes")
    // A subdomain of an allowed host is another host.
    expect((await checkWebhookUrl("https://x.relay.t3.codes/hook", { hosts: ["relay.t3.codes"] }))[0]).toMatchObject({ code: "WEBHOOKS_URL_REFUSED" })
  })

  it("passes a public https URL on an allowed host", async () => {
    const [error, url] = await checkWebhookUrl(`https://relay.t3.codes/hooks/abc?token=${token}`, { hosts: ["relay.t3.codes"] })
    expect(error).toBeUndefined()
    expect(url?.host).toBe("relay.t3.codes")
  })
})

describe("member endpoints", () => {
  it("throws when member endpoints are not installed", async () => {
    installWebhooks({ webhooks: {}, store: createDrizzleWebhookStore(drizzle({ client })) })
    await expect(getMemberEndpoint("user_ana")).rejects.toMatchObject({ code: "WEBHOOKS_ENDPOINTS_OFF" })
  })

  it("only takes relay.t3.codes by default", async () => {
    const [error] = await createMemberEndpoint({ owner: "user_ana", name: "Thread", kind: "url", url: "https://hooks.example.com/abc", secret })
    expect(error?.message).toContain("is not relay.t3.codes")
    const [refused] = await createMemberEndpoint({ owner: "user_ana", name: "Thread", kind: "url", url: "https://127.0.0.1/abc", secret, hosts: ["127.0.0.1"] })
    expect(refused?.message).toContain("loopback")
    const [, endpoint] = await createMemberEndpoint({ owner: "user_ana", name: "Thread", kind: "url", url: `https://relay.t3.codes/hooks/abc?token=${token}`, secret })
    expect(endpoint).toMatchObject({ owner: "user_ana", kind: "url", host: "relay.t3.codes" })
  })

  it("stores no plaintext URL or secret, and returns only the host", async () => {
    const endpoint = await connect()
    expect(endpoint).toEqual({ id: expect.stringMatching(/^whe_/), owner: "user_ana", ownerName: null, ownerEmail: null, name: "Launch plan thread", kind: "url", agent: "t3", host: publicHost, disabledAt: null, disabledBy: null, createdAt: expect.any(Number), updatedAt: expect.any(Number) })
    await sendToMemberEndpoint("user_ana", { threads: ["thr_1"] }, { event: "comments.send", key: "k1" })
    const rows = await client.execute("SELECT * FROM vitehub_webhook_endpoints")
    const deliveries = await client.execute("SELECT * FROM vitehub_webhook_deliveries")
    const stored = JSON.stringify([rows.rows, deliveries.rows])
    expect(rows.rows).toHaveLength(1)
    expect(stored).not.toContain(token)
    expect(stored).not.toContain("/hooks/abc")
    expect(stored).not.toContain(secret)
    expect(String(rows.rows[0]!.sealed)).toMatch(/^[a-f0-9]{24}:[a-f0-9]+$/)
    expect(await getMemberEndpoint("user_ana")).toEqual([undefined, endpoint])
  })

  it("posts in the request, and the receiver verifies the signature", async () => {
    const endpoint = await connect()
    const [error, sent] = await sendToMemberEndpoint("user_ana", { threads: ["thr_1", "thr_2"] }, { event: "comments.send", key: "thr_1:msg_8,thr_2:msg_3" })
    expect(error).toBeUndefined()
    expect(sent).toEqual({ id: expect.stringMatching(/^whd_/), status: "sent" })
    expect(received).toHaveLength(1)
    const [delivery] = received
    expect(delivery!.url).toBe(`/hooks/abc?token=${token}`)
    expect(delivery!.headers).toMatchObject({ "x-vitehub-delivery": sent!.id, "x-vitehub-event": "comments.send", "x-vitehub-events": "1", "content-type": "application/json" })
    process.env.MEMBER_SECRET = secret
    try {
      const headers = new Headers(Object.entries(delivery!.headers).flatMap(([name, value]) => typeof value === "string" ? [[name, value] as [string, string]] : []))
      const request = new Request(`${receiverOrigin}${delivery!.url}`, { body: delivery!.body, headers, method: "POST" })
      expect(await verifyWebhook(request, { provider: "github", secret: "MEMBER_SECRET" })).toEqual([undefined, { threads: ["thr_1", "thr_2"] }])
    }
    finally {
      delete process.env.MEMBER_SECRET
    }
    const [, stored] = await getWebhookDelivery(sent!.id)
    expect(stored).toMatchObject({ webhook: `@${endpoint.id}`, key: "thr_1:msg_8,thr_2:msg_3", state: "sent", attempts: 1, lastStatus: 202 })
  })

  it("posts once for repeated sends with the same key", async () => {
    await connect()
    const first = await sendToMemberEndpoint("user_ana", { n: 1 }, { event: "comments.send", key: "same" })
    const again = await sendToMemberEndpoint("user_ana", { n: 2 }, { event: "comments.send", key: "same" })
    const together = await Promise.all([1, 2, 3].map(n => sendToMemberEndpoint("user_ana", { n }, { event: "comments.send", key: "together" })))
    expect(again).toEqual(first)
    expect(first[1]?.status).toBe("sent")
    expect(new Set(together.map(([, sent]) => sent?.id)).size).toBe(1)
    expect(received.map(request => JSON.parse(request.body))).toEqual([{ n: 1 }, expect.objectContaining({ n: expect.any(Number) })])
    const [, deliveries] = await listWebhookDeliveries()
    expect(deliveries).toHaveLength(2)
  })

  it("returns failed without Queue, and a new send with the key posts again", async () => {
    await connect()
    statuses = [500]
    const [, failed] = await sendToMemberEndpoint("user_ana", { n: 1 }, { event: "comments.send", key: "retry" })
    expect(failed?.status).toBe("failed")
    expect((await getWebhookDelivery(failed!.id))[1]).toMatchObject({ state: "dead", lastStatus: 500, lastError: "HTTP 500" })
    const [, retried] = await sendToMemberEndpoint("user_ana", { n: 2 }, { event: "comments.send", key: "retry" })
    expect(retried).toEqual({ id: expect.not.stringMatching(failed!.id), status: "sent" })
    expect(received).toHaveLength(2)
  })

  it("does not follow a redirect", async () => {
    await connect()
    statuses = [307]
    const [, sent] = await sendToMemberEndpoint("user_ana", {}, { event: "comments.send", key: "redirect" })
    expect(sent?.status).toBe("failed")
    expect(received).toHaveLength(1)
  })

  it("hands a failed attempt to the Queue when the app has one", async () => {
    install({ queue: true })
    await connect()
    statuses = [503]
    const [, sent] = await sendToMemberEndpoint("user_ana", { n: 1 }, { event: "comments.send", key: "queued" })
    expect(sent?.status).toBe("pending")
    expect(wakes).toEqual([{ wake: { id: sent!.id, revision: 1 }, delay: "10s" }])
    await deliverWebhookWake(wakes[0]!.wake)
    expect(received).toHaveLength(2)
    expect(received[1]!.headers["x-vitehub-delivery"]).toBe(sent!.id)
    expect((await getWebhookDelivery(sent!.id))[1]).toMatchObject({ state: "sent", attempts: 2 })
    // While the delivery waits or after it is sent, the same key posts nothing.
    expect(await sendToMemberEndpoint("user_ana", { n: 2 }, { event: "comments.send", key: "queued" })).toEqual([undefined, { id: sent!.id, status: "sent" }])
  })

  it("keeps an inbox delivery without a post", async () => {
    const [, endpoint] = await createMemberEndpoint({ owner: "user_mei", name: "Claude Code", agent: "claude-code", kind: "inbox" })
    expect(endpoint).toMatchObject({ kind: "inbox", host: null })
    const [, sent] = await sendToMemberEndpoint("user_mei", { threads: ["thr_1"] }, { event: "comments.send", key: "inbox" })
    expect(sent?.status).toBe("inbox")
    expect(received).toEqual([])
    expect((await getWebhookDelivery(sent!.id))[1]).toMatchObject({ webhook: `@${endpoint!.id}`, state: "sent", body: { threads: ["thr_1"] } })
  })

  it("replaces, removes, and disables endpoints for their owner only", async () => {
    const first = await connect()
    const second = await connect()
    expect(second.id).not.toBe(first.id)
    expect((await client.execute("SELECT id FROM vitehub_webhook_endpoints")).rows).toEqual([expect.objectContaining({ id: second.id })])
    expect((await removeMemberEndpoint("user_tom", second.id))[0]).toMatchObject({ code: "WEBHOOKS_ENDPOINT_NOT_FOUND" })
    const [, disabled] = await disableMemberEndpoint(second.id)
    expect(disabled?.disabledAt).toEqual(expect.any(Number))
    expect((await sendToMemberEndpoint("user_ana", {}, { event: "comments.send", key: "off" }))[0]).toMatchObject({ code: "WEBHOOKS_ENDPOINT_DISABLED" })
    expect((await removeMemberEndpoint("user_ana", second.id))[1]?.id).toBe(second.id)
    expect(await getMemberEndpoint("user_ana")).toEqual([undefined, null])
    expect((await sendToMemberEndpoint("user_ana", {}, { event: "comments.send", key: "none" }))[0]).toMatchObject({ code: "WEBHOOKS_ENDPOINT_NOT_FOUND" })
    expect(received).toEqual([])
  })

  it("needs VITEHUB_WEBHOOKS_KEY, and a sealed endpoint opens only with its key and row", async () => {
    delete process.env.VITEHUB_WEBHOOKS_KEY
    expect((await createMemberEndpoint({ owner: "user_ana", name: "Thread", kind: "url", url: endpointUrl, secret, hosts: [publicHost] }))[0]).toMatchObject({ code: "WEBHOOKS_KEY_UNSET" })
    process.env.VITEHUB_WEBHOOKS_KEY = "too-short"
    expect((await createMemberEndpoint({ owner: "user_ana", name: "Thread", kind: "url", url: endpointUrl, secret, hosts: [publicHost] }))[0]).toMatchObject({ code: "WEBHOOKS_KEY_INVALID" })
    process.env.VITEHUB_WEBHOOKS_KEY = btoa("a".repeat(32))
    await connect("user_ana")
    await connect("user_tom")
    // A sealed URL copied to another member's row does not open there.
    await client.execute("UPDATE vitehub_webhook_endpoints SET sealed = (SELECT sealed FROM vitehub_webhook_endpoints WHERE owner = 'user_ana') WHERE owner = 'user_tom'")
    expect((await sendToMemberEndpoint("user_tom", {}, { event: "comments.send", key: "copied" }))[0]).toMatchObject({ code: "WEBHOOKS_KEY_INVALID" })
    process.env.VITEHUB_WEBHOOKS_KEY = btoa("b".repeat(32))
    expect((await sendToMemberEndpoint("user_ana", {}, { event: "comments.send", key: "rotated" }))[0]).toMatchObject({ code: "WEBHOOKS_KEY_INVALID" })
    expect(received).toEqual([])
  })
})
