import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { verifyWebhook } from "@vite-hub/env"
import { emitRunFailed } from "@vite-hub/runtime/internal/run-failed"

import { createLocalQueueClient, createLocalQueueEngine, localQueueDeliveryRules } from "../../queue/src/providers/local.ts"
import { createDrizzleWebhookStore, webhooksTables } from "../src/database.ts"
import { defineWebhook, sendWebhook } from "../src/index.ts"
import {
  cancelWebhookDelivery,
  deliverWebhookWake,
  flushWebhookDelivery,
  getWebhookDelivery,
  installWebhooks,
  listPendingWebhookDeliveries,
  listWebhookDeliveries,
  listWebhooks,
  redeliverWebhookDelivery,
  webhooksQueueName,
} from "../src/runtime.ts"

import type { IncomingHttpHeaders, Server } from "node:http"
import type { LocalQueueEngine } from "../../queue/src/providers/local.ts"
import type { WebhookDefinition } from "../src/index.ts"

declare module "../src/index.ts" {
  interface WebhookRegistry {
    "now": WebhookDefinition
    "stripe": WebhookDefinition
    "t3": WebhookDefinition
    "hourly": WebhookDefinition
    "unset": WebhookDefinition
    "alerts": WebhookDefinition
    "alerts-digest": WebhookDefinition
  }
}

interface Received {
  headers: IncomingHttpHeaders
  body: string
  url: string
}

const secret = "whsec_test_secret"
// The token stands for the T3 relay token in the URL. No error or stored field may hold it.
const token = "relay-token-9f2c"

let server: Server
let receiverUrl: string
let received: Received[] = []
// The status of each next answer. When empty, the receiver answers 200.
let statuses: number[] = []
let engine: LocalQueueEngine
let base: string

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", chunk => chunks.push(chunk))
    request.on("end", () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8"), url: request.url ?? "" })
      response.statusCode = statuses.shift() ?? 200
      response.end("ok")
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The receiver has no port.")
  receiverUrl = `http://127.0.0.1:${address.port}/hooks?token=${token}`
  process.env.WEBHOOK_TEST_URL = receiverUrl
  process.env.WEBHOOK_TEST_SECRET = secret

  const client = createClient({ url: ":memory:" })
  await client.executeMultiple(`${webhooksTables.join(";\n")};`)
  base = await mkdtemp(join(tmpdir(), "vitehub-webhooks-"))
  // The local Queue provider, as `vite dev` and a Node server run it. Retries come after 50 ms, not 1, 2, and 4 seconds.
  const queueDefinition = { handler: (job: { payload: unknown }) => deliverWebhookWake(job.payload), options: { concurrency: 4 } }
  engine = createLocalQueueEngine({
    base,
    load: async name => name === webhooksQueueName ? queueDefinition : undefined,
    missing: name => new Error(`No Queue ${name}.`),
    retryDelayMs: () => 50,
    rules: localQueueDeliveryRules.local,
  })
  await engine.start()
  const queue = createLocalQueueClient(engine, webhooksQueueName)
  const target = { url: "WEBHOOK_TEST_URL", secret: "WEBHOOK_TEST_SECRET" }
  installWebhooks({
    webhooks: {
      now: defineWebhook(target),
      stripe: defineWebhook({ ...target, signature: "stripe" }),
      t3: defineWebhook({ ...target, debounce: "300ms" }),
      hourly: defineWebhook({ ...target, debounce: "1 hour" }),
      unset: defineWebhook({ url: "WEBHOOK_UNSET_URL", secret: "WEBHOOK_TEST_SECRET" }),
      "alerts": defineWebhook({ ...target, events: ["workflow.failed", "invocation.failed"] }),
      "alerts-digest": defineWebhook({ ...target, debounce: "300ms", events: ["schedule.failed"] }),
    },
    store: createDrizzleWebhookStore(drizzle({ client })),
    wake: (wake, options) => queue.send(wake, options),
  })
})

afterEach(() => {
  received = []
  statuses = []
})

afterAll(async () => {
  engine.close()
  await new Promise(resolve => server.close(resolve))
  await rm(base, { force: true, recursive: true })
})

function asRequest(entry: Received): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(entry.headers)) if (typeof value === "string") headers.set(name, value)
  return new Request(`http://127.0.0.1${entry.url}`, { method: "POST", headers, body: entry.body })
}

async function delivery(id: string) {
  const [error, value] = await getWebhookDelivery(id)
  if (error) throw error
  return value
}

describe("sendWebhook", () => {
  it("delivers at once with a GitHub signature that verifyWebhook() accepts", async () => {
    const [error, sent] = await sendWebhook("now", { thread: "thr_1", message: "msg_1" }, { event: "comments.comment" })
    expect(error).toBeUndefined()
    expect(sent).toEqual({ id: expect.stringMatching(/^whd_/), status: "pending" })
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 })
    const [request] = received
    expect(request!.headers).toMatchObject({
      "content-type": "application/json",
      "x-hub-signature-256": expect.stringMatching(/^sha256=[0-9a-f]{64}$/),
      "x-vitehub-delivery": sent!.id,
      "x-vitehub-event": "comments.comment",
      "x-vitehub-events": "1",
    })
    expect(request!.url).toBe(`/hooks?token=${token}`)
    expect(await verifyWebhook(asRequest(request!), { provider: "github", secret: "WEBHOOK_TEST_SECRET" })).toEqual([undefined, { thread: "thr_1", message: "msg_1" }])
    await vi.waitFor(async () => expect(await delivery(sent!.id)).toMatchObject({ state: "sent", attempts: 1, lastStatus: 200, count: 1, sentAt: expect.any(Number) }))
  })

  it("signs with the Stripe scheme when the webhook asks for it", async () => {
    const [, sent] = await sendWebhook("stripe", { id: "evt_1" }, { event: "forms.submit" })
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 })
    expect(received[0]!.headers["stripe-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    expect(await verifyWebhook(asRequest(received[0]!), { provider: "stripe", secret: "WEBHOOK_TEST_SECRET" })).toEqual([undefined, { id: "evt_1" }])
    expect(received[0]!.headers["x-vitehub-delivery"]).toBe(sent!.id)
  })

  it("collapses 5 sends in the debounce into 1 delivery with the last body and the count", async () => {
    const ids: string[] = []
    for (let index = 1; index <= 5; index++) {
      const [error, sent] = await sendWebhook("t3", { comment: index }, { event: "comments.comment" })
      expect(error).toBeUndefined()
      ids.push(sent!.id)
    }
    // Every send of the window is the same delivery.
    expect(new Set(ids).size).toBe(1)
    const [, pending] = await listPendingWebhookDeliveries({ webhook: "t3" })
    expect(pending).toEqual([expect.objectContaining({ id: ids[0], state: "pending", revision: 5, count: 5, body: { comment: 5 } })])
    expect(received).toHaveLength(0)
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 })
    // The older wakes find a newer revision or a sent delivery, so nothing else arrives.
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect(received).toHaveLength(1)
    expect(JSON.parse(received[0]!.body)).toEqual({ comment: 5 })
    expect(received[0]!.headers).toMatchObject({ "x-vitehub-events": "5", "x-vitehub-delivery": ids[0] })
    expect(await delivery(ids[0]!)).toMatchObject({ state: "sent", count: 5, revision: 5 })
  })

  it("starts a new delivery for a send after the last one went out, and keeps other keys apart", async () => {
    const [, first] = await sendWebhook("t3", { n: 1 }, { event: "comments.comment", key: "thread-a" })
    const [, other] = await sendWebhook("t3", { n: 2 }, { event: "comments.comment", key: "thread-b" })
    expect(first!.id).not.toBe(other!.id)
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5_000 })
    const [, again] = await sendWebhook("t3", { n: 3 }, { event: "comments.comment", key: "thread-a" })
    expect(again!.id).not.toBe(first!.id)
    await vi.waitFor(() => expect(received).toHaveLength(3), { timeout: 5_000 })
  })

  it("retries after a 500 with the same delivery id, then marks it sent", async () => {
    statuses = [500]
    const [, sent] = await sendWebhook("now", { retry: true }, { event: "blob.upload" })
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5_000 })
    expect(received.map(entry => entry.headers["x-vitehub-delivery"])).toEqual([sent!.id, sent!.id])
    expect(received[0]!.body).toBe(received[1]!.body)
    await vi.waitFor(async () => expect(await delivery(sent!.id)).toMatchObject({ state: "sent", attempts: 2, lastStatus: 200, lastError: null }))
  })

  it("marks a delivery dead after the last attempt, and keeps the URL token out of its error", async () => {
    statuses = [500, 500, 500, 500, 500]
    const [, sent] = await sendWebhook("now", { dead: true }, { event: "content.publish" })
    await vi.waitFor(async () => expect(await delivery(sent!.id)).toMatchObject({ state: "dead", attempts: 4, lastStatus: 500, lastError: "HTTP 500" }), { timeout: 5_000 })
    expect(received).toHaveLength(4)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(received).toHaveLength(4)

    // A receiver that is down: the error names the failure, not the address or the token.
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve))
    const address = closed.address()
    await new Promise(resolve => closed.close(resolve))
    process.env.WEBHOOK_TEST_URL = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 1}/hooks?token=${token}`
    try {
      const [, down] = await sendWebhook("now", { down: true }, { event: "auth.sign-in" })
      await vi.waitFor(async () => expect(await delivery(down!.id)).toMatchObject({ state: "dead", attempts: 4, lastStatus: null, lastError: "network error ECONNREFUSED" }), { timeout: 5_000 })
    }
    finally {
      process.env.WEBHOOK_TEST_URL = receiverUrl
    }
    const [, deliveries] = await listWebhookDeliveries({ state: "dead" })
    expect(JSON.stringify(deliveries)).not.toContain(token)
  })

  it("flushes a pending delivery now, cancels another, and redelivers a sent one", async () => {
    const [, flushed] = await sendWebhook("hourly", { digest: 1 }, { event: "comments.comment", key: "flush" })
    const [, cancelled] = await sendWebhook("hourly", { digest: 2 }, { event: "comments.comment", key: "cancel" })
    const [, pending] = await listPendingWebhookDeliveries({ webhook: "hourly" })
    expect(pending?.map(entry => entry.id).sort()).toEqual([flushed!.id, cancelled!.id].sort())
    expect(pending![0]!.dueAt).toBeGreaterThan(Date.now() + 59 * 60_000)

    const [flushError, flushedDelivery] = await flushWebhookDelivery(flushed!.id)
    expect(flushError).toBeUndefined()
    expect(flushedDelivery).toMatchObject({ id: flushed!.id, state: "pending" })
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 })
    expect(JSON.parse(received[0]!.body)).toEqual({ digest: 1 })
    await vi.waitFor(async () => expect(await delivery(flushed!.id)).toMatchObject({ state: "sent" }))

    const [cancelError, cancelledDelivery] = await cancelWebhookDelivery(cancelled!.id)
    expect(cancelError).toBeUndefined()
    expect(cancelledDelivery).toMatchObject({ state: "cancelled" })
    // A cancelled delivery is not pending, so its wake and a flush do nothing.
    const [notPending] = await flushWebhookDelivery(cancelled!.id)
    expect(notPending).toMatchObject({ code: "WEBHOOKS_DELIVERY_NOT_PENDING" })
    expect((await listPendingWebhookDeliveries({ webhook: "hourly" }))[1]).toEqual([])

    const [redeliverError, redelivered] = await redeliverWebhookDelivery(flushed!.id)
    expect(redeliverError).toBeUndefined()
    expect(redelivered!.id).not.toBe(flushed!.id)
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5_000 })
    expect(received[1]!.headers["x-vitehub-delivery"]).toBe(redelivered!.id)
    expect(JSON.parse(received[1]!.body)).toEqual({ digest: 1 })
    expect(received).toHaveLength(2)

    const [missing] = await cancelWebhookDelivery("whd_missing")
    expect(missing).toMatchObject({ code: "WEBHOOKS_DELIVERY_NOT_FOUND" })
  })

  it("returns a coded error for a missing URL or secret, without the values", async () => {
    const [urlError] = await sendWebhook("unset", {}, { event: "test" })
    expect(urlError).toMatchObject({ code: "WEBHOOKS_URL_UNSET", fix: expect.stringContaining("Set the variable") })
    expect(urlError!.message).toContain("WEBHOOK_UNSET_URL")

    delete process.env.WEBHOOK_TEST_SECRET
    try {
      const [secretError] = await sendWebhook("now", {}, { event: "test" })
      expect(secretError).toMatchObject({ code: "WEBHOOKS_SECRET_UNSET" })
      expect(secretError!.message).toContain("WEBHOOK_TEST_SECRET")
    }
    finally {
      process.env.WEBHOOK_TEST_SECRET = secret
    }

    process.env.WEBHOOK_TEST_URL = `ftp://example.com/?token=${token}`
    try {
      const [invalid] = await sendWebhook("now", {}, { event: "test" })
      expect(invalid).toMatchObject({ code: "WEBHOOKS_URL_INVALID" })
      expect(invalid!.message).not.toContain(token)
    }
    finally {
      process.env.WEBHOOK_TEST_URL = receiverUrl
    }

    const [bodyError] = await sendWebhook("now", 1n, { event: "test" })
    expect(bodyError).toMatchObject({ code: "WEBHOOKS_BODY_INVALID" })
    expect(received).toHaveLength(0)
  })

  it("lists the webhooks with their variable names, not their values", () => {
    expect(listWebhooks()).toEqual(expect.arrayContaining([
      { name: "t3", url: "WEBHOOK_TEST_URL", secret: "WEBHOOK_TEST_SECRET", signature: "github", debounceMs: 300, events: [], urlSet: true, secretSet: true, host: new URL(receiverUrl).host },
      expect.objectContaining({ name: "alerts", events: ["workflow.failed", "invocation.failed"] }),
      expect.objectContaining({ name: "unset", urlSet: false, secretSet: true, host: null }),
    ]))
    expect(JSON.stringify(listWebhooks())).not.toContain(token)
  })

  it("throws for an unknown name", async () => {
    // @ts-expect-error The name is not in the WebhookRegistry.
    await expect(sendWebhook("missing", {}, { event: "test" })).rejects.toMatchObject({ code: "WEBHOOKS_NOT_FOUND" })
  })
})

describe("failure events", () => {
  it("sends workflow.failed and invocation.failed to the webhook that lists them, signed, with a line for chat apps", async () => {
    await emitRunFailed({ event: "workflow.failed", workflow: "send-digest", runId: "run_1", error: { message: "SMTP timeout", code: "EMAIL_SEND_FAILED" }, failedAt: "2026-11-18T10:00:00.000Z" })
    await emitRunFailed({ event: "invocation.failed", agent: "support", invocationId: "inv_1", error: { message: "Model refused" }, failedAt: "2026-11-18T10:01:00.000Z" })
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5_000 })
    const byEvent = Object.fromEntries(received.map(entry => [entry.headers["x-vitehub-event"], entry]))
    expect(await verifyWebhook(asRequest(byEvent["workflow.failed"]!), { provider: "github", secret: "WEBHOOK_TEST_SECRET" })).toEqual([undefined, {
      event: "workflow.failed",
      workflow: "send-digest",
      runId: "run_1",
      error: { message: "SMTP timeout", code: "EMAIL_SEND_FAILED" },
      failedAt: "2026-11-18T10:00:00.000Z",
      text: "The Workflow run run_1 of \"send-digest\" failed: SMTP timeout",
    }])
    expect(JSON.parse(byEvent["invocation.failed"]!.body)).toMatchObject({ agent: "support", invocationId: "inv_1", text: "The Agent Invocation inv_1 of \"support\" failed: Model refused" })
  })

  it("sends an event only to the webhooks that list it", async () => {
    await emitRunFailed({ event: "workflow.failed", workflow: "import", runId: "run_2", error: { message: "boom" }, failedAt: "2026-11-18T10:00:00.000Z" })
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(received).toHaveLength(1)
  })

  it("collapses repeated failures of one Schedule in the debounce, and keeps other Schedules apart", async () => {
    for (const runId of ["srun_1", "srun_2", "srun_3"]) {
      await emitRunFailed({ event: "schedule.failed", schedule: "nightly-sync", runId, error: { message: `failed ${runId}` }, failedAt: "2026-11-18T03:00:00.000Z" })
    }
    await emitRunFailed({ event: "schedule.failed", schedule: "hourly-report", runId: "srun_9", error: { message: "other" }, failedAt: "2026-11-18T03:00:00.000Z" })
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5_000 })
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(received).toHaveLength(2)
    const nightly = received.find(entry => JSON.parse(entry.body).schedule === "nightly-sync")!
    expect(nightly.headers["x-vitehub-events"]).toBe("3")
    expect(JSON.parse(nightly.body)).toMatchObject({ event: "schedule.failed", runId: "srun_3", text: "The Schedule run srun_3 of \"nightly-sync\" failed: failed srun_3" })
  })
})

describe("defineWebhook", () => {
  it("fails at define time for a debounce above the host limit, or a value in place of a variable name", () => {
    expect(() => defineWebhook({ url: "U", secret: "S", debounce: "25 hours" })).toThrow(expect.objectContaining({ code: "WEBHOOKS_DEBOUNCE_TOO_LONG" }))
    expect(() => defineWebhook({ url: "https://example.com/hook", secret: "S" })).toThrow(expect.objectContaining({ code: "WEBHOOKS_DEFINITION_INVALID" }))
    expect(() => defineWebhook({ url: "U", secret: "S", debounce: "soon" })).toThrow(expect.objectContaining({ code: "WEBHOOKS_DEFINITION_INVALID" }))
    expect(defineWebhook({ url: "U", secret: "S", debounce: "30 minutes" })).toMatchObject({ debounceMs: 1_800_000, signature: "github" })
    // @ts-expect-error `events` lists only the events that ViteHub sends by itself.
    expect(() => defineWebhook({ url: "U", secret: "S", events: ["workflow.done"] })).toThrow(expect.objectContaining({ code: "WEBHOOKS_DEFINITION_INVALID" }))
    expect(defineWebhook({ url: "U", secret: "S", events: ["schedule.failed", "schedule.failed"] })).toMatchObject({ events: ["schedule.failed"] })
  })
})
