import { createServer } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"
import { collectOperationContributions, createOperationRegistry, runOperation } from "@vite-hub/internal/operations"
import { createStandaloneOperationHandler } from "@vite-hub/internal/operations-dev"

import { runViteHubCli } from "../../cli/src/index.ts"
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"
import { createLocalQueueClient, createLocalQueueEngine, localQueueDeliveryRules } from "../../queue/src/providers/local.ts"
import { createDrizzleWebhookStore, webhooksTables } from "../src/database.ts"
import { defineWebhook, sendWebhook } from "../src/index.ts"
import { webhooksOperations } from "../src/operations.ts"
import { deliverWebhookWake, installWebhooks, webhooksQueueName } from "../src/runtime.ts"
import { hubWebhooks } from "../src/vite.ts"

import type { IncomingHttpHeaders, Server } from "node:http"
import type { LocalQueueEngine } from "../../queue/src/providers/local.ts"
import type { WebhookDefinition } from "../src/index.ts"

declare module "../src/index.ts" {
  interface WebhookRegistry {
    "now": WebhookDefinition
    "digest": WebhookDefinition
    "unset": WebhookDefinition
  }
}

interface Received {
  headers: IncomingHttpHeaders
  body: string
}

// The token stands for the T3 relay token in the URL. No operation result may hold it.
const token = "relay-token-7c1e"

let server: Server
let receiverHost: string
let received: Received[] = []
let engine: LocalQueueEngine
let base: string
let root: string
let handler: ReturnType<typeof createStandaloneOperationHandler>

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", chunk => chunks.push(chunk))
    request.on("end", () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") })
      response.end("ok")
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The receiver has no port.")
  receiverHost = `127.0.0.1:${address.port}`
  process.env.WEBHOOK_OPS_URL = `http://${receiverHost}/hooks?token=${token}`
  process.env.WEBHOOK_OPS_SECRET = "whsec_ops_secret"

  const client = createClient({ url: ":memory:" })
  await client.executeMultiple(`${webhooksTables.join(";\n")};`)
  base = await mkdtemp(join(tmpdir(), "vitehub-webhooks-ops-"))
  root = join(base, "app")
  await mkdir(root)
  const queueDefinition = { handler: (job: { payload: unknown }) => deliverWebhookWake(job.payload), options: { concurrency: 4 } }
  engine = createLocalQueueEngine({
    base: join(base, "queue"),
    load: async name => name === webhooksQueueName ? queueDefinition : undefined,
    missing: name => new Error(`No Queue ${name}.`),
    retryDelayMs: () => 50,
    rules: localQueueDeliveryRules.local,
  })
  await engine.start()
  const queue = createLocalQueueClient(engine, webhooksQueueName)
  const target = { url: "WEBHOOK_OPS_URL", secret: "WEBHOOK_OPS_SECRET" }
  installWebhooks({
    webhooks: {
      now: defineWebhook(target),
      digest: defineWebhook({ ...target, debounce: "1 hour" }),
      unset: defineWebhook({ url: "WEBHOOK_OPS_UNSET_URL", secret: "WEBHOOK_OPS_SECRET" }),
    },
    store: createDrizzleWebhookStore(drizzle({ client })),
    wake: (wake, options) => queue.send(wake, options),
  })
  // The handler of the generated `POST /_vitehub/rpc` route of `vite dev`, with the Webhooks operations.
  handler = createStandaloneOperationHandler([{ operations: webhooksOperations, plugin: "@vite-hub/webhooks/vite" }], root)
})

afterEach(() => {
  received = []
})

afterAll(async () => {
  engine.close()
  await new Promise(resolve => server.close(resolve))
  await rm(base, { force: true, recursive: true })
})

/** A loopback request to the app, as `vite dev` gets it. */
function local(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return handler.fetch(Object.assign(new Request(url, init), { ip: "127.0.0.1" }))
}

/** One call through the operation RPC: `{ ok: true, value }` or `{ ok: false, code, message, status }`. */
async function rpc(operation: string, input?: unknown) {
  const response = await local("http://localhost:5173/_vitehub/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vitehub-console": "1" },
    body: operationRpcBody(operation, input),
  })
  return operationRpcResponseResult(response)
}

async function value<T = Record<string, unknown>>(operation: string, input?: unknown): Promise<T> {
  const result = await rpc(operation, input)
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
  return result.value
}

async function sent(id: string) {
  await vi.waitFor(async () => expect(await value("webhooks.get", { id })).toMatchObject({ state: "sent" }), { timeout: 5_000 })
}

function stream() {
  let text = ""
  return { output: () => text, write: (chunk: string | Uint8Array) => { text += String(chunk); return true } }
}

/** `vitehub <args>` against the dev server of the app. */
async function cli(args: string[]) {
  const stdout = stream()
  const stderr = stream()
  const plugin = { name: "@vite-hub/webhooks/vite", vitehub: { operations: [{ export: "webhooksOperations", load: async () => webhooksOperations, module: "@vite-hub/webhooks/operations" }] } }
  const code = await runViteHubCli({
    args,
    cwd: root,
    env: { VITEHUB_DEV_SERVER_URL: "http://localhost:5173" },
    fetch: local,
    loadConfig: async () => ({ plugins: [plugin], root }),
    loadNuxtViteConfig: async () => undefined,
    stderr,
    stdout,
  })
  return { code, stderr: stderr.output(), stdout: stdout.output() }
}

describe("webhooks operations through the RPC", () => {
  it("lists the webhooks with the URL host, never its path, query, or the secret", async () => {
    const list = await value<Array<Record<string, unknown>>>("webhooks.list", {})
    expect(list).toEqual([
      { name: "digest", url: "WEBHOOK_OPS_URL", secret: "WEBHOOK_OPS_SECRET", signature: "github", debounceMs: 3_600_000, events: [], urlSet: true, secretSet: true, host: receiverHost },
      { name: "now", url: "WEBHOOK_OPS_URL", secret: "WEBHOOK_OPS_SECRET", signature: "github", debounceMs: 0, events: [], urlSet: true, secretSet: true, host: receiverHost },
      { name: "unset", url: "WEBHOOK_OPS_UNSET_URL", secret: "WEBHOOK_OPS_SECRET", signature: "github", debounceMs: 0, events: [], urlSet: false, secretSet: true, host: null },
    ])
    expect(JSON.stringify(list)).not.toMatch(new RegExp(`${token}|whsec_|/hooks`))
  })

  it("sends a test delivery at once, past the debounce, with the event webhooks.test", async () => {
    const [, pendingSend] = await sendWebhook("digest", { real: true }, { event: "comments.comment" })
    const tested = await value<{ id: string, status: string }>("webhooks.test", { name: "digest" })
    expect(tested).toEqual({ id: expect.stringMatching(/^whd_/), status: "pending" })
    expect(tested.id).not.toBe(pendingSend!.id)
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 })
    expect(received[0]!.headers).toMatchObject({ "x-vitehub-event": "webhooks.test", "x-vitehub-delivery": tested.id, "x-vitehub-events": "1" })
    expect(JSON.parse(received[0]!.body)).toEqual({ test: true, webhook: "digest" })
    await sent(tested.id)
    // The real send still waits for its debounce, with its own body.
    expect(await value("webhooks.get", { id: pendingSend!.id })).toMatchObject({ state: "pending", body: { real: true } })
    await value("webhooks.cancel", { id: pendingSend!.id })

    const custom = await value<{ id: string }>("webhooks.test", { name: "now", body: { thread: "thr_1" } })
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5_000 })
    expect(JSON.parse(received[1]!.body)).toEqual({ thread: "thr_1" })
    expect(received[1]!.headers["x-vitehub-delivery"]).toBe(custom.id)
  })

  it("lists pending deliveries, flushes one, cancels one, shows one, and redelivers one", async () => {
    const [, first] = await sendWebhook("digest", { digest: 1 }, { event: "comments.comment", key: "flush" })
    const [, second] = await sendWebhook("digest", { digest: 2 }, { event: "comments.comment", key: "cancel" })
    const pending = await value<Array<{ id: string, dueAt: number }>>("webhooks.pending", { webhook: "digest" })
    expect(pending.map(entry => entry.id).sort()).toEqual([first!.id, second!.id].sort())
    expect(pending[0]!.dueAt).toBeGreaterThan(Date.now() + 59 * 60_000)
    expect(await value<unknown[]>("webhooks.pending", { webhook: "digest", limit: 1 })).toHaveLength(1)

    expect(await value("webhooks.flush", { id: first!.id })).toMatchObject({ id: first!.id, state: "pending" })
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 })
    expect(JSON.parse(received[0]!.body)).toEqual({ digest: 1 })
    await sent(first!.id)

    expect(await value("webhooks.cancel", { id: second!.id })).toMatchObject({ id: second!.id, state: "cancelled" })
    expect(await value("webhooks.pending", { webhook: "digest" })).toEqual([])

    expect(await value("webhooks.get", { id: first!.id })).toMatchObject({ webhook: "digest", event: "comments.comment", body: { digest: 1 }, attempts: 1, lastStatus: 200 })
    const sentList = await value<Array<{ id: string }>>("webhooks.deliveries", { webhook: "digest", state: "sent" })
    expect(sentList.map(entry => entry.id)).toContain(first!.id)
    expect(await value<Array<{ state: string }>>("webhooks.deliveries", { state: "cancelled", limit: 1 })).toEqual([expect.objectContaining({ state: "cancelled" })])

    const again = await value<{ id: string }>("webhooks.redeliver", { id: first!.id })
    expect(again.id).not.toBe(first!.id)
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5_000 })
    expect(received[1]!.headers).toMatchObject({ "x-vitehub-delivery": again.id, "x-vitehub-event": "comments.comment" })
    expect(JSON.parse(received[1]!.body)).toEqual({ digest: 1 })
  })

  it("fails with the Webhooks code, the fix, and an HTTP status", async () => {
    const [, pendingSend] = await sendWebhook("digest", {}, { event: "test", key: "errors" })
    expect(await rpc("webhooks.redeliver", { id: pendingSend!.id })).toMatchObject({ ok: false, code: "WEBHOOKS_DELIVERY_ACTIVE", status: 409 })
    await value("webhooks.cancel", { id: pendingSend!.id })
    expect(await rpc("webhooks.flush", { id: pendingSend!.id })).toMatchObject({ ok: false, code: "WEBHOOKS_DELIVERY_NOT_PENDING", status: 409, fix: expect.stringContaining("redeliver") })
    expect(await rpc("webhooks.get", { id: "whd_missing" })).toMatchObject({ ok: false, code: "WEBHOOKS_DELIVERY_NOT_FOUND", status: 404 })
    expect(await rpc("webhooks.test", { name: "missing" })).toMatchObject({ ok: false, code: "WEBHOOKS_NOT_FOUND", status: 404 })
    const unset = await rpc("webhooks.test", { name: "unset" })
    expect(unset).toMatchObject({ ok: false, code: "WEBHOOKS_URL_UNSET", status: 409, fix: expect.stringContaining("Set the variable") })
    expect(unset.message).toContain("WEBHOOK_OPS_UNSET_URL")
    expect((await rpc("webhooks.deliveries", { limit: 0 })).ok).toBe(false)
    expect((await rpc("webhooks.flush", {})).ok).toBe(false)
    expect(received).toHaveLength(0)
  })

  it("lets a read-only grant, such as the read_operation tool of MCP, read and nothing else", async () => {
    const registry = createOperationRegistry([{ operations: webhooksOperations }])
    const context = { access: { mode: "console", sections: ["webhooks:read"] }, surface: "mcp" as const, user: null }
    const kinds = Object.fromEntries(webhooksOperations.map(operation => [operation.name, operation.kind]))
    expect(kinds).toEqual({
      "webhooks.list": "read",
      "webhooks.deliveries": "read",
      "webhooks.pending": "read",
      "webhooks.get": "read",
      "webhooks.test": "write",
      "webhooks.flush": "write",
      "webhooks.cancel": "write",
      "webhooks.redeliver": "write",
      "webhooks.endpoints": "read",
      "webhooks.disable-endpoint": "write",
      "webhooks.enable-endpoint": "write",
    })
    expect(await runOperation(registry, "webhooks.list", {}, context)).toMatchObject({ ok: true })
    expect(await runOperation(registry, "webhooks.pending", {}, context)).toMatchObject({ ok: true })
    for (const [name, input] of [["webhooks.test", { name: "now" }], ["webhooks.flush", { id: "whd_x" }], ["webhooks.cancel", { id: "whd_x" }], ["webhooks.redeliver", { id: "whd_x" }]] as const) {
      expect(await runOperation(registry, name, input, context)).toMatchObject({ ok: false, code: "INTERNAL_R0023", status: 403 })
    }
    expect(received).toHaveLength(0)
  })
})

describe("vitehub webhooks", () => {
  it("lists the webhooks as JSON, also as the default command", async () => {
    const listed = await cli(["webhooks", "list"])
    expect(listed).toMatchObject({ code: 0, stderr: "" })
    expect(JSON.parse(listed.stdout).map((webhook: { name: string }) => webhook.name)).toEqual(["digest", "now", "unset"])
    expect(listed.stdout).not.toContain(token)
    expect(JSON.parse((await cli(["webhooks"])).stdout)).toEqual(JSON.parse(listed.stdout))
    const help = await cli(["webhooks", "--help"])
    for (const command of ["cancel", "deliveries", "flush", "get", "list", "pending", "redeliver", "test"]) expect(help.stdout).toContain(command)
  })

  it("tests a webhook with a JSON body, then lists, shows, and redelivers the delivery", async () => {
    const tested = await cli(["webhooks", "test", "now", "--body", "{\"hello\":\"world\"}"])
    expect(tested).toMatchObject({ code: 0, stderr: "" })
    const { id } = JSON.parse(tested.stdout) as { id: string }
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 })
    expect(JSON.parse(received[0]!.body)).toEqual({ hello: "world" })
    expect(received[0]!.headers["x-vitehub-event"]).toBe("webhooks.test")
    await sent(id)

    const deliveries = await cli(["webhooks", "deliveries", "--webhook", "now", "--state", "sent", "--limit", "1"])
    expect(deliveries.code).toBe(0)
    expect(JSON.parse(deliveries.stdout)).toEqual([expect.objectContaining({ id, webhook: "now", state: "sent", event: "webhooks.test" })])

    const shown = await cli(["webhooks", "get", id])
    expect(JSON.parse(shown.stdout)).toMatchObject({ id, body: { hello: "world" }, lastStatus: 200 })

    const redelivered = await cli(["webhooks", "redeliver", id])
    expect(redelivered.code).toBe(0)
    const again = JSON.parse(redelivered.stdout) as { id: string }
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5_000 })
    expect(received[1]!.headers["x-vitehub-delivery"]).toBe(again.id)
  })

  it("lists pending deliveries, flushes one, and cancels another", async () => {
    const [, first] = await sendWebhook("digest", { n: 1 }, { event: "forms.submit", key: "cli-flush" })
    const [, second] = await sendWebhook("digest", { n: 2 }, { event: "forms.submit", key: "cli-cancel" })
    const pending = await cli(["webhooks", "pending", "--webhook", "digest"])
    expect(pending.code).toBe(0)
    expect(JSON.parse(pending.stdout).map((entry: { id: string }) => entry.id).sort()).toEqual([first!.id, second!.id].sort())

    const flushed = await cli(["webhooks", "flush", first!.id])
    expect(flushed.code).toBe(0)
    expect(JSON.parse(flushed.stdout)).toMatchObject({ id: first!.id })
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 })
    expect(JSON.parse(received[0]!.body)).toEqual({ n: 1 })

    const cancelled = await cli(["webhooks", "cancel", second!.id])
    expect(cancelled.code).toBe(0)
    expect(JSON.parse(cancelled.stdout)).toMatchObject({ id: second!.id, state: "cancelled" })
    expect(JSON.parse((await cli(["webhooks", "pending", "--webhook", "digest"])).stdout)).toEqual([])
  })

  it("exits with 1 and the code for a failed call", async () => {
    const missing = await cli(["webhooks", "flush", "whd_missing"])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("WEBHOOKS_DELIVERY_NOT_FOUND")
    const json = await cli(["webhooks", "test", "unset", "--json"])
    expect(json.code).toBe(1)
    expect(JSON.parse(json.stdout)).toMatchObject({ error: { code: "WEBHOOKS_URL_UNSET" } })
  })
})

describe("hubWebhooks operations", () => {
  it("contributes the operations only when the app has a webhook", async () => {
    const project = join(base, "project")
    await mkdir(join(project, "server/webhooks"), { recursive: true })
    const plugin = hubWebhooks({ database: true, queue: true })
    const config = Object.assign({ root: project }, { [VITEHUB_PROJECT_ROOT]: project })
    const configHook = plugin.config as { handler: (config: object) => void }
    configHook.handler(config)
    expect(await collectOperationContributions([plugin])).toEqual([])

    await writeFile(join(project, "server/webhooks/t3.ts"), "export default {}\n")
    const [entry] = await collectOperationContributions([plugin])
    expect(entry).toMatchObject({ module: "@vite-hub/webhooks/operations", export: "webhooksOperations", plugin: "@vite-hub/webhooks/vite" })
    expect(await entry!.load!()).toBe(webhooksOperations)
  })
})
