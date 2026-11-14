import { createHmac } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { channelAdapter, defineChannelTrigger, ignored } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { drainDeferredWebhookAdmissions } from "../src/server/webhook-inbox.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

const secret = "ack-secret"
const scope = "webhook:ack:hook:hook:"
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function setup(options: { ackTimeoutMs?: number | false, signature?: "github-sha256" | "stripe-sha256", url?: string } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-ack-"))
  const state = createLibsqlAgentState({ url: options.url ?? `file:${join(stateDir, "state.sqlite")}` })
  const invokes: number[] = []
  let gate: Promise<void> | undefined
  let status: number | undefined
  const agent = defineAgent({
    channels: {
      hook: channelAdapter("hook", {
        messages: false,
        triggers: {
          webhook: defineChannelTrigger({
            async invoke(_context, input) {
              // SAFETY: The test sends JSON bodies of this shape.
              const n = (input as { payload: { n: number } }).payload.n
              invokes.push(n)
              await gate
              if (status) return new Response(null, { status })
              return ignored(`seen:${n}`)
            },
          }),
        },
        webhooks: {
          ...(options.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: options.ackTimeoutMs }),
          path: "/hook",
          provider: "hook",
          secretHeader: "x-hub-signature-256",
          secretToken: secret,
          signature: options.signature ?? "github-sha256",
        },
      }),
    },
    driver: { run: () => "unused" },
  })
  const routeOptions = { agentName: "ack", webhookState: state }
  const create = () => createChannelWebhookRouteHandler(agent as never)
  const handler = create()
  cleanups.push(async () => {
    await state.disconnect()
    await rm(stateDir, { force: true, recursive: true })
  })
  const sign = (body: string) => {
    if (options.signature !== "stripe-sha256") return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
    const t = Math.floor(Date.now() / 1000)
    return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`
  }
  const send = (n: number, signature?: string) =>
    handler(new Request("https://example.com/hook", {
      body: JSON.stringify({ n }),
      headers: { "content-type": "application/json", "x-github-delivery": `delivery-${n}`, "x-hub-signature-256": signature === undefined ? sign(JSON.stringify({ n })) : `sha256=${signature}` },
      method: "POST",
    }), "", routeOptions)
  // Every replay index row of this scope, whichever list holds it.
  const indexRows = async () => {
    await state.connect()
    const rows = await state.extension("webhook_ack_test").execute(
      "SELECT value FROM vitehub_agent_state_lists WHERE key LIKE ? ORDER BY id",
      [`${scope}inbox%`],
    )
    return rows.map(row => String(row.value))
  }
  const inbox = async () => {
    const rows = []
    // The replay index can list an ID more than once; replay reads each stored request once.
    const ids = new Set<string>()
    for (const value of await indexRows()) {
      const entry = JSON.parse(value) as { id: string }
      if (ids.has(entry.id)) continue
      ids.add(entry.id)
      const row = await state.get(`${scope}inbox:${encodeURIComponent(entry.id)}`)
      if (row) rows.push(row as { attempts: number, receivedAt: string, request: { body: string } })
    }
    return rows
  }
  return {
    create,
    hold: () => { const held = deferred(); gate = held.promise; return held },
    inbox,
    indexRows,
    invokes,
    routeOptions,
    send,
    setStatus: (value: number | undefined) => { status = value },
    state,
  }
}

/** An entry of the legacy replay list, which kept a complete copy of each request. */
function legacyEntry(n: number, receivedAt: number, attempts: number) {
  return {
    attempts,
    id: `delivery-index-only-${n}`,
    receivedAt: new Date(receivedAt).toISOString(),
    // Replay checks the signature again, so the stored request keeps its signed headers.
    request: {
      body: `{"n":${n}}`,
      headers: { "content-type": "application/json", "x-github-delivery": `delivery-index-only-${n}`, "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(`{"n":${n}}`).digest("hex")}` },
      method: "POST",
      url: "https://example.com/hook",
    },
    webhookId: "",
  }
}

function logEvents(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.flatMap(([line]) => {
    if (typeof line !== "string" || !line.startsWith("{")) return []
    const parsed = JSON.parse(line) as { event?: string, scope?: string }
    return parsed.scope === "vitehub.channel.delivery" && parsed.event ? [parsed.event] : []
  })
}

describe("webhook acknowledgement after store", () => {
  it("answers with the trigger response when admission is fast, and removes the stored request", async () => {
    const { inbox, send } = await setup({ ackTimeoutMs: 1_000 })
    const response = await send(1)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ reason: "seen:1" })
    await expect(inbox()).resolves.toEqual([])
  })

  it("answers 202 at the budget and lets admission finish in the background", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const { hold, inbox, send } = await setup({ ackTimeoutMs: 50 })
    const held = hold()
    const response = await send(2)
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ accepted: true, deferred: true, ok: true })
    await expect(inbox()).resolves.toMatchObject([{ attempts: 1 }])

    await expect(drainDeferredWebhookAdmissions()).resolves.toEqual({ pending: 1, unsettled: 1 })
    held.resolve()
    await expect(drainDeferredWebhookAdmissions({ timeoutMs: 1_000 })).resolves.toEqual({ pending: 1, unsettled: 0 })
    await expect(inbox()).resolves.toEqual([])
    expect(logEvents(info)).toEqual(["admission.deferred", "admission.completed"])
  })

  it("keeps a deferred admission that ends in a 5xx for the next process", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const { hold, inbox, send, setStatus } = await setup({ ackTimeoutMs: 20 })
    const held = hold()
    setStatus(503)
    expect((await send(3)).status).toBe(202)
    held.resolve()
    await drainDeferredWebhookAdmissions({ timeoutMs: 1_000 })
    await expect(inbox()).resolves.toMatchObject([{ attempts: 1 }])
    expect(logEvents(error)).toEqual(["admission.failed"])
  })

  it("replays a request that a stopped process left, through the route, after a restart", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const { create, hold, inbox, invokes, routeOptions, send, setStatus } = await setup({ ackTimeoutMs: 20 })
    const stuck = hold()
    expect((await send(4)).status).toBe(202)
    await vi.waitFor(() => expect(invokes).toEqual([4]))
    // A live admission in this process holds the inbox lock and renews its owner lease, and replay
    // rightly does not take it over (#2625). End it the way a failed process does: a 5xx keeps the row.
    setStatus(503)
    stuck.resolve()
    await vi.waitFor(async () => expect((await inbox())[0]).toMatchObject({ attempts: 1 }))
    const [left] = await inbox()
    expect(JSON.parse(left!.request.body)).toEqual({ n: 4 })

    // The next process: admission is fast again, and its recovery boundary is its start time.
    setStatus(undefined)
    hold().resolve()
    const restarted = create()
    const stop = restarted.resume({ ...routeOptions, recoverInterruptedBefore: Date.now() })
    await vi.waitFor(async () => expect(await inbox()).toEqual([]), { timeout: 5_000 })
    expect(invokes).toEqual([4, 4])
    expect(logEvents(info)).toEqual(expect.arrayContaining(["inbox.replaying", "inbox.replayed"]))
    await stop()
  })

  it("replays a timestamp-signed request after its signature tolerance has passed", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { create, hold, inbox, invokes, routeOptions, send, setStatus } = await setup({ ackTimeoutMs: 20, signature: "stripe-sha256" })
    const stuck = hold()
    expect((await send(5)).status).toBe(202)
    await vi.waitFor(() => expect(invokes).toEqual([5]))
    setStatus(503)
    stuck.resolve()
    await vi.waitFor(async () => expect((await inbox())[0]).toMatchObject({ attempts: 1 }))
    const [left] = await inbox()

    // The next process starts ten minutes later, past the 300 second stripe-sha256 tolerance.
    const now = Date.now
    vi.spyOn(Date, "now").mockImplementation(() => now() + 600_000)
    setStatus(503)
    hold().resolve()
    const restarted = create()
    const stop = restarted.resume({ ...routeOptions, recoverInterruptedBefore: Date.now() })
    await vi.waitFor(() => expect(invokes).toEqual([5, 5]), { timeout: 5_000 })
    // The replay keeps the first arrival time, so a later replay checks the same window.
    await vi.waitFor(async () => expect(await inbox()).toMatchObject([{ attempts: 2, receivedAt: left!.receivedAt }]))
    await stop()
  })

  it("preserves attempts when replay recovers an index-only entry of the legacy list", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "info").mockImplementation(() => {})
    const { create, inbox, invokes, routeOptions, state, setStatus } = await setup({ ackTimeoutMs: 1_000 })
    setStatus(503)
    await state.connect()
    // A copy from two days ago belongs to an admission whose settled marker has expired.
    await state.appendToList(`${scope}inbox`, legacyEntry(10, Date.now() - 2 * 86_400_000, 1))
    await state.appendToList(`${scope}inbox`, legacyEntry(9, Date.now() - 1_000, 2))
    const stop = create().resume({ ...routeOptions, recoverInterruptedBefore: Date.now() })
    // The route stores attempt 3 before it runs the trigger, so wait for the trigger as well.
    await vi.waitFor(() => expect(invokes).toEqual([9]), { timeout: 4_000 })
    await vi.waitFor(async () => expect(await inbox()).toMatchObject([{ attempts: 3 }]))
    await stop()
    expect(invokes).toEqual([9])
  })

  it("keeps a legacy request newer than the recovery boundary replayable by a later restart", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "info").mockImplementation(() => {})
    const { create, invokes, routeOptions, state } = await setup({ ackTimeoutMs: 1_000 })
    await state.connect()
    const body = `{"n":11}`
    // A process of the previous version stored this request after the new process started.
    const receivedAt = Date.now()
    await state.appendToList(`${scope}inbox`, {
      attempts: 1, id: "delivery-legacy-late", receivedAt: new Date(receivedAt).toISOString(), webhookId: "",
      request: { body, method: "POST", url: "https://example.com/hook",
        headers: { "content-type": "application/json", "x-github-delivery": "delivery-legacy-late", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` } },
    })
    const first = create().resume({ ...routeOptions, recoverInterruptedBefore: receivedAt - 1_000 })
    await new Promise(resolve => setTimeout(resolve, 500))
    await first()
    expect(invokes).toEqual([])
    const second = create().resume({ ...routeOptions, recoverInterruptedBefore: receivedAt + 1_000 })
    await vi.waitFor(() => expect(invokes).toEqual([11]), { timeout: 4_000 })
    await second()
  })

  it("reads the legacy list a page at a time, and only once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "info").mockImplementation(() => {})
    const { create, invokes, routeOptions, state } = await setup({ ackTimeoutMs: 1_000 })
    await state.connect()
    // 250 copies from two days ago, then one request still to replay.
    for (let n = 100; n < 350; n++) await state.appendToList(`${scope}inbox`, legacyEntry(n, Date.now() - 2 * 86_400_000, 1))
    await state.appendToList(`${scope}inbox`, legacyEntry(99, Date.now() - 1_000, 1))
    const getList = vi.spyOn(state, "getList")
    const first = create().resume({ ...routeOptions, recoverInterruptedBefore: Date.now() })
    await vi.waitFor(() => expect(invokes).toEqual([99]), { timeout: 5_000 })
    await first()
    expect(getList.mock.calls.some(([key]) => key === `${scope}inbox`)).toBe(false)

    // The next restart starts after the last row the first one read.
    const getListPage = vi.spyOn(state, "getListPage")
    const second = create().resume({ ...routeOptions, recoverInterruptedBefore: Date.now() })
    await vi.waitFor(() => expect(getListPage).toHaveBeenCalled(), { timeout: 5_000 })
    await second()
    await expect(getListPage.mock.results[0]!.value).resolves.toEqual([])
    expect(invokes).toEqual([99])
  })

  it("replays a request that a process whose clock ran 2 s ahead indexed in the next hour", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "info").mockImplementation(() => {})
    const { create, invokes, routeOptions, send, setStatus } = await setup({ ackTimeoutMs: 1_000 })
    const hour = 3_600_000
    const nextHour = (Math.floor(Date.now() / hour) + 1) * hour
    let clock = nextHour + 1_000
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    setStatus(503)
    await (await send(12)).arrayBuffer()
    setStatus(undefined)
    // The next process runs 2 s behind, still in the previous hour, and its boundary is after the arrival.
    clock = nextHour - 1_000
    const stop = create().resume({ ...routeOptions, recoverInterruptedBefore: nextHour + 1_500 })
    await vi.waitFor(() => expect(invokes).toEqual([12, 12]), { timeout: 5_000 })
    await stop()
  })

  it("answers a duplicate with a retryable 503 while the first request has not stored its copy", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "info").mockImplementation(() => {})
    const { indexRows, send, state } = await setup({ ackTimeoutMs: 1_000 })
    const rowKey = `${scope}inbox:delivery-13`
    const stopped = deferred()
    const set = state.set.bind(state)
    // The first process stops after its index write and before its row write.
    vi.spyOn(state, "set").mockImplementation(async (key, value, ttlMs) => {
      if (key === rowKey) {
        await stopped.promise
        throw new Error("process stopped")
      }
      return await set(key, value, ttlMs)
    })
    const first = send(13)
    await vi.waitFor(async () => expect(await indexRows()).toHaveLength(1))
    const duplicate = await send(13)
    // A 2xx would tell the provider the request is safe, but no restart could replay it.
    expect(duplicate.status).toBe(503)
    expect(duplicate.headers.get("retry-after")).toBe("1")
    stopped.resolve()
    await (await first).arrayBuffer()
  })

  it("keeps the replay index to the retention window while webhooks keep arriving", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { create, indexRows, invokes, routeOptions, send, setStatus, state } = await setup({ ackTimeoutMs: 1_000 })
    const now = Date.now
    let offset = 0
    vi.spyOn(Date, "now").mockImplementation(() => now() + offset)
    // One webhook an hour for four days. Each one settles, except n = 90, which ends in a 5xx and stays stored.
    for (let n = 1; n <= 96; n++) {
      offset = n * 3_600_000
      setStatus(n === 90 ? 503 : undefined)
      await (await send(n)).arrayBuffer()
    }
    setStatus(undefined)
    await state.cleanupExpiredState()

    const rows = await indexRows()
    // The index keeps about one day of webhooks, not all four, and no request bodies.
    expect(rows.length).toBeGreaterThanOrEqual(24)
    expect(rows.length).toBeLessThanOrEqual(27)
    expect(rows.some(value => value.includes("\"body\""))).toBe(false)

    // The next process replays the unsettled request and skips the settled ones.
    invokes.length = 0
    offset += 60_000
    const stop = create().resume({ ...routeOptions, recoverInterruptedBefore: Date.now() })
    await vi.waitFor(() => expect(invokes).toEqual([90]), { timeout: 5_000 })
    await stop()
    expect(invokes).toEqual([90])
  })

  it("drops a stored request after 3 admissions", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "info").mockImplementation(() => {})
    const { create, inbox, invokes, routeOptions, state } = await setup({ ackTimeoutMs: 1_000 })
    // A settled admission leaves a marker that replay skips (#2625), so this row belongs to an admission that never settled.
    await state.connect()
    await state.appendToList(`${scope}inbox`, { id: "delivery-5" })
    await state.set(`${scope}inbox:delivery-5`, {
      attempts: 3,
      id: "delivery-5",
      receivedAt: new Date(Date.now() - 1_000).toISOString(),
      request: { body: "{\"n\":5}", headers: {}, method: "POST", url: "https://example.com/hook" },
      webhookId: "",
    })
    const stop = create().resume({ ...routeOptions, recoverInterruptedBefore: Date.now() })
    await vi.waitFor(async () => expect(await inbox()).toEqual([]), { timeout: 5_000 })
    expect(invokes).toEqual([])
    expect(logEvents(error)).toContain("inbox.dropped")
    await stop()
  })

  it("waits for admission with ackTimeoutMs: false and stores nothing", async () => {
    const { inbox, send, state } = await setup({ ackTimeoutMs: false })
    const set = vi.spyOn(state, "set")
    const response = await send(6)
    expect(response.status).toBe(200)
    expect(set.mock.calls.some(([key]) => String(key).includes("inbox"))).toBe(false)
    await expect(inbox()).resolves.toEqual([])
  })

  it("waits for admission when webhook State is not durable", async () => {
    const { hold, send } = await setup({ ackTimeoutMs: 20, url: ":memory:" })
    const held = hold()
    const response = send(7)
    await new Promise(resolve => setTimeout(resolve, 100))
    held.resolve()
    expect((await response).status).toBe(200)
  })

  it("rejects a forged request before it stores anything", async () => {
    const { inbox, invokes, send } = await setup()
    const response = await send(8, "00")
    expect(response.status).toBe(401)
    expect(invokes).toEqual([])
    await expect(inbox()).resolves.toEqual([])
  })
})
