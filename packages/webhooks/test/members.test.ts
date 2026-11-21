import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { verifyWebhook } from "@vite-hub/env"

import { createDrizzleWebhookEndpointStore, createDrizzleWebhookStore, webhooksTables } from "../src/database.ts"
import { checkWebhookUrl, createMemberEndpoint, disableMemberEndpoint, getMemberEndpoint, listMemberDeliveries, removeMemberEndpoint, removeMemberEndpoints, sendToMemberEndpoint } from "../src/index.ts"
import { deliverWebhookWake, getWebhookDelivery, installWebhooks, listWebhookDeliveries } from "../src/runtime.ts"

import type { Client } from "@libsql/client"
import type { RequestOptions } from "node:https"
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

const httpsRequest = vi.hoisted(() => vi.fn())
vi.mock("node:https", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:https")>(),
  request: httpsRequest,
}))

interface Received {
  headers: Record<string, string>
  body: string
  url: string
}

const secret = "whsec_member_secret"
// The token stands for the T3 relay token in the URL. No stored row may hold it.
const token = "relay-token-7c1d"
// A public address in TEST-NET-3. The receiver is stubbed.
const publicHost = "203.0.113.10"
const endpointUrl = `https://${publicHost}/hooks/abc?token=${token}`

let received: Received[] = []
let statuses: number[] = []
let client: Client
let wakes: Array<{ wake: WebhookWake, delay: unknown }> = []

function install(options: { queue?: boolean, wakeError?: Error } = {}) {
  const db = drizzle({ client })
  installWebhooks({
    webhooks: {},
    store: createDrizzleWebhookStore(db),
    endpoints: createDrizzleWebhookEndpointStore(db),
    ...options.queue
      ? { wake: async (wake: WebhookWake, wakeOptions: { delay: unknown }) => {
          if (options.wakeError) return [options.wakeError, undefined] as const
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

it("can retry the same key after the Queue rejects a wake", async () => {
  install({ queue: true, wakeError: new Error("Queue unavailable") })
  await connect()
  statuses = [503, 202]
  const send = () => sendToMemberEndpoint("user_ana", { hello: true }, { key: "handoff", event: "comments.send" })
  expect((await send())[0]).toMatchObject({ code: "WEBHOOKS_WAKE_FAILED" })
  expect((await listWebhookDeliveries())[1]).toEqual([expect.objectContaining({ state: "dead", lastStatus: 503 })])
  install({ queue: true })
  const retried = await Promise.all([send(), send(), send()])
  expect(new Set(retried.map(([, data]) => data?.id)).size).toBe(1)
  expect(retried.some(([, data]) => data?.status === "sent")).toBe(true)
  expect(received).toHaveLength(2)
})

it("uses only the checked addresses without replacing the HTTPS hostname on either attempt", async () => {
  install({ queue: true })
  const url = `https://relay.t3.codes/hooks/abc?token=${token}`
  const [error] = await createMemberEndpoint({ owner: "user_ana", name: "Launch plan", kind: "url", url, secret })
  expect(error).toBeUndefined()
  httpsRequest.mockImplementation((target: URL, options: RequestOptions, onResponse: (response: { statusCode: number, destroy: () => void }) => void) => {
    expect(target.href).toBe(url)
    expect(options.agent).toBe(false)
    const lookup = vi.fn()
    options.lookup?.(target.hostname, { all: true }, lookup)
    expect(lookup).toHaveBeenCalledWith(null, [
      { address: "104.21.3.218", family: 4 },
      { address: "2606:4700:3035::ac43:999b", family: 6 },
    ])
    return {
      on: vi.fn(),
      end: (body: string) => {
        received.push({ headers: {}, body, url: target.pathname + target.search })
        onResponse({ statusCode: statuses.shift() ?? 202, destroy: vi.fn() })
      },
    }
  })
  statuses = [302, 202]
  const [sendError, delivery] = await sendToMemberEndpoint("user_ana", { hello: true }, { key: "checked", event: "comments.send" })
  expect(sendError).toBeUndefined()
  expect(delivery?.status).toBe("pending")
  expect(received).toHaveLength(1)
  await deliverWebhookWake(wakes[0]!.wake)
  expect((await getWebhookDelivery(delivery!.id))[1]?.state).toBe("sent")
  expect(httpsRequest).toHaveBeenCalledTimes(2)
  expect(received).toHaveLength(2)
})

beforeEach(async () => {
  received = []
  statuses = []
  wakes = []
  httpsRequest.mockReset()
  process.env.VITEHUB_WEBHOOKS_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  client = createClient({ url: ":memory:" })
  await client.executeMultiple(`${webhooksTables.join(";\n")};`)
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    expect(url.hostname).toBe(publicHost)
    expect(request.redirect).toBe("manual")
    expect(request.method).toBe("POST")
    received.push({ headers: Object.fromEntries(request.headers), body: await request.text(), url: url.pathname + url.search })
    return new Response("ok", { status: statuses.shift() ?? 202 })
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

  it.each([
    ["an IPv4-compatible loopback", "https://[::7f00:1]/hook", "loopback"],
    ["an IPv4-compatible metadata address", "https://[::a9fe:a9fe]/hook", "metadata"],
    ["a 6to4 loopback", "https://[2002:7f00:1::]/hook", "6to4 address of a loopback"],
    ["a 6to4 metadata address", "https://[2002:a9fe:a9fe::]/hook", "6to4 address of a link-local"],
    ["a local-use NAT64 address", "https://[64:ff9b:1::a9fe:a9fe]/hook", "local-use NAT64"],
  ])("refuses %s", async (_, url, reason) => {
    const [error] = await checkWebhookUrl(url)
    expect(error).toMatchObject({ code: "WEBHOOKS_URL_REFUSED" })
    expect(error?.message).toContain(reason)
  })

  it("passes a 6to4 address of a public IPv4 address", async () => {
    expect((await checkWebhookUrl("https://[2002:cb00:710a::1]/hook"))[0]).toBeUndefined()
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

  it("refuses a send to a host outside the current `hosts`, and records no delivery", async () => {
    await connect()
    const [error] = await sendToMemberEndpoint("user_ana", {}, { event: "comments.send", key: "narrowed", hosts: ["relay.t3.codes"] })
    expect(error).toMatchObject({ code: "WEBHOOKS_URL_REFUSED" })
    expect(error?.message).toContain("is not relay.t3.codes")
    expect(received).toHaveLength(0)
    expect((await client.execute("SELECT * FROM vitehub_webhook_deliveries")).rows).toHaveLength(0)
    expect((await sendToMemberEndpoint("user_ana", {}, { event: "comments.send", key: "allowed", hosts: [publicHost] }))[1]).toMatchObject({ status: "sent" })
  })

  it("stores no plaintext URL or secret, and returns only the host", async () => {
    const endpoint = await connect()
    expect(endpoint).toEqual({ id: expect.stringMatching(/^whe_/), owner: "user_ana", ownerName: null, ownerEmail: null, name: "Launch plan thread", address: null, kind: "url", agent: "t3", host: publicHost, disabledAt: null, disabledBy: null, createdAt: expect.any(Number), updatedAt: expect.any(Number) })
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
      const request = new Request(`https://${publicHost}${delivery!.url}`, { body: delivery!.body, headers: delivery!.headers, method: "POST" })
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

  it("keeps one endpoint per address, sends to the one with the send's address, and else to the newest", async () => {
    const threadA = "t3-thread://v2/env-1/thread-a"
    // A millisecond apart, so the inbox is the newest endpoint.
    const now = Date.now()
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(now)
    const [, a] = await createMemberEndpoint({ owner: "user_ana", name: "Thread A", agent: "t3", address: threadA, kind: "url", url: endpointUrl, secret, hosts: [publicHost] })
    vi.setSystemTime(now + 1)
    const [, inbox] = await createMemberEndpoint({ owner: "user_ana", name: "Claude Code", agent: "claude-code", kind: "inbox" })
    vi.useRealTimers()
    expect(a).toMatchObject({ address: threadA })
    expect(inbox).toMatchObject({ address: null })
    expect(await getMemberEndpoint("user_ana", { address: ` ${threadA} ` })).toEqual([undefined, a])
    expect(await getMemberEndpoint("user_ana", { address: "t3-thread://v2/env-1/gone" })).toEqual([undefined, inbox])
    expect(await getMemberEndpoint("user_ana")).toEqual([undefined, inbox])

    const [, toA] = await sendToMemberEndpoint("user_ana", { n: 1 }, { event: "comments.send", key: "k1", address: ` ${threadA} ` })
    expect(toA?.status).toBe("sent")
    expect(received).toHaveLength(1)
    const [, toNewest] = await sendToMemberEndpoint("user_ana", { n: 2 }, { event: "comments.send", key: "k2", address: "t3-thread://v2/env-1/gone" })
    expect(toNewest?.status).toBe("inbox")
    expect(received).toHaveLength(1)

    // Pairing thread A again replaces its endpoint and leaves the inbox.
    const [, again] = await createMemberEndpoint({ owner: "user_ana", name: "Thread A", agent: "t3", address: threadA, kind: "url", url: endpointUrl, secret, hosts: [publicHost] })
    expect((await client.execute("SELECT id FROM vitehub_webhook_endpoints ORDER BY id")).rows.map(row => row.id).toSorted()).toEqual([again!.id, inbox!.id].toSorted())
  })

  it("lists the deliveries of the endpoint a send reaches, newest first, page by page", async () => {
    expect(await listMemberDeliveries("user_mei")).toEqual([undefined, null])
    const [, endpoint] = await createMemberEndpoint({ owner: "user_mei", name: "Codex", agent: "codex", kind: "inbox" })
    // One millisecond apart, so newest first is one order.
    vi.useFakeTimers({ toFake: ["Date"] })
    for (const n of [1, 2, 3]) {
      vi.setSystemTime(1_800_000_000_000 + n)
      await sendToMemberEndpoint("user_mei", { n }, { event: "comments.send", key: `k${n}` })
    }
    vi.useRealTimers()
    const [, first] = await listMemberDeliveries("user_mei", { limit: 2 })
    expect(first?.endpoint).toEqual(endpoint)
    expect(first?.deliveries.map(delivery => delivery.body)).toEqual([{ n: 3 }, { n: 2 }])
    const last = first!.deliveries.at(-1)!
    const [, next] = await listMemberDeliveries("user_mei", { limit: 2, before: { createdAt: last.createdAt, id: last.id } })
    expect(next?.deliveries.map(delivery => delivery.body)).toEqual([{ n: 1 }])
    const [, newer] = await createMemberEndpoint({ owner: "user_mei", name: "Other inbox", address: "other", kind: "inbox" })
    await sendToMemberEndpoint("user_mei", { n: 4 }, { event: "comments.send", key: "other", endpointId: newer!.id })
    expect((await listMemberDeliveries("user_mei", { endpointId: endpoint!.id, limit: 1 }))[1]?.deliveries.map(delivery => delivery.body)).toEqual([{ n: 3 }])
    expect((await listMemberDeliveries("user_mei", { address: "" }))[1]?.endpoint.id).toBe(endpoint!.id)
    expect((await listMemberDeliveries("user_mei", { address: " other " }))[1]?.endpoint.id).toBe(newer!.id)
    expect(await listMemberDeliveries("user_tom", { endpointId: endpoint!.id })).toEqual([undefined, null])
    expect((await listWebhookDeliveries({ owner: "user_mei" }))[1]).toHaveLength(4)
    expect((await listWebhookDeliveries({ owner: "user_mei", webhook: `@${endpoint!.id}` }))[1]).toHaveLength(3)
    expect((await listWebhookDeliveries({ owner: "user_tom", webhook: `@${endpoint!.id}` }))[1]).toEqual([])
    await removeMemberEndpoint("user_mei", endpoint!.id)
    expect((await sendToMemberEndpoint("user_mei", {}, { event: "comments.send", key: "removed", endpointId: endpoint!.id }))[0]?.code).toBe("WEBHOOKS_ENDPOINT_NOT_FOUND")
    // Another member's deliveries stay theirs.
    await connect("user_tom")
    expect((await listMemberDeliveries("user_tom"))[1]?.deliveries).toEqual([])
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

  it("removes every endpoint of one member, and no other member's", async () => {
    const [, inbox] = await createMemberEndpoint({ owner: "user_ana", name: "Claude Code inbox", agent: "claude-code", kind: "inbox", address: "inbox:claude" })
    const thread = await connect("user_ana")
    const other = await connect("user_tom")
    const [error, removed] = await removeMemberEndpoints("user_ana")
    expect(error).toBeUndefined()
    expect(removed?.map(endpoint => endpoint.id).sort()).toEqual([inbox!.id, thread.id].sort())
    expect(removed?.[0]).not.toHaveProperty("sealed")
    expect(await getMemberEndpoint("user_ana")).toEqual([undefined, null])
    expect((await getMemberEndpoint("user_tom"))[1]?.id).toBe(other.id)
    expect(await removeMemberEndpoints("user_ana")).toEqual([undefined, []])
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
