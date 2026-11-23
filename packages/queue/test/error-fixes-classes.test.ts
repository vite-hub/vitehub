import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"

import { queueErrorDiagnostics } from "../src/error-diagnostics.ts"
import { missingQueueDefinitionError, setQueueRuntimeConfig } from "../src/internal/runtime/state.ts"
import { createLocalQueueClient, createLocalQueueEngine, localQueueDeliveryRules } from "../src/providers/local.ts"
import { createVercelQueueClient } from "../src/providers/vercel.ts"
import { listQueueJobs, sendToQueue } from "../src/runtime/operations.ts"

const codes = {
  QUEUE_DEFINITION_NAME_INVALID: queueErrorDiagnostics.QUEUE_DEFINITION_NAME_INVALID(),
  QUEUE_JOBS_UNAVAILABLE: queueErrorDiagnostics.QUEUE_JOBS_UNAVAILABLE({ driver: "vercel" }),
  QUEUE_JOB_DUPLICATE: queueErrorDiagnostics.QUEUE_JOB_DUPLICATE(),
  QUEUE_JOB_NOT_FOUND: queueErrorDiagnostics.QUEUE_JOB_NOT_FOUND(),
  QUEUE_JOB_RUNNING: queueErrorDiagnostics.QUEUE_JOB_RUNNING(),
  QUEUE_LOCAL_LIMIT_EXCEEDED: queueErrorDiagnostics.QUEUE_LOCAL_LIMIT_EXCEEDED({ limit: "batch-empty", provider: "Vercel", value: 0 }),
  QUEUE_VERCEL_BATCH_REJECTED: queueErrorDiagnostics.QUEUE_VERCEL_BATCH_REJECTED({ failed: 1, total: 2 }),
  QUEUE_VERCEL_SEND_BATCH_UNAVAILABLE: queueErrorDiagnostics.QUEUE_VERCEL_SEND_BATCH_UNAVAILABLE(),
}

let base: string

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "vitehub-queue-error-classes-"))
})

afterAll(async () => {
  await rm(base, { force: true, recursive: true })
})

afterEach(() => {
  setQueueRuntimeConfig(undefined)
})

it("gives each code that replaced a plain error a fix and its own docs page", () => {
  for (const [code, error] of Object.entries(codes)) {
    expect(error.code, code).toBe(code)
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/queue/diagnostics/${code.toLowerCase()}`)
  }
})

it("recommends the standalone codemod for the former Queue definition form", () => {
  const error = queueErrorDiagnostics.QUEUE_INVALID_DEFINITION({ reason: "`defineQueue(handler, options)` was removed." })
  expect(error.fix).toContain("`npx @vite-hub/codemods define-forms`")
})

it("gives an operation failure its code, fix, and HTTP status", async () => {
  await expect(sendToQueue({ payload: {}, queue: "../welcome" })).rejects.toMatchObject({
    code: "QUEUE_DEFINITION_NAME_INVALID",
    fix: expect.stringContaining("vitehub queue list"),
    status: 400,
  })
  setQueueRuntimeConfig({ driver: "vercel", region: "iad1" } as never, vi.fn())
  await expect(listQueueJobs({})).rejects.toMatchObject({ code: "QUEUE_JOBS_UNAVAILABLE", status: 409, statusMessage: expect.stringContaining("vercel") })
})

it("puts a local provider limit in the cause of QUEUE_PROVIDER_FAILED with a fix", async () => {
  const engine = createLocalQueueEngine({
    base,
    load: async () => ({ handler: async () => {} }),
    missing: missingQueueDefinitionError,
    rules: localQueueDeliveryRules.cloudflare,
  })
  const [error] = await createLocalQueueClient(engine, "welcome").sendBatch(Array.from({ length: 101 }, () => ({ body: {} })))
  expect(error).toMatchObject({ code: "QUEUE_PROVIDER_FAILED" })
  expect(error?.cause).toMatchObject({
    code: "QUEUE_LOCAL_LIMIT_EXCEEDED",
    fix: expect.stringContaining("`sendBatch()`"),
    message: "Cloudflare accepts up to 100 jobs in one `sendBatch()`, got 101.",
  })
})

it("keeps the per-job results on the cause when Vercel rejects jobs of a batch", async () => {
  const results = [{ messageId: "a", status: "sent" }, { error: new Error("rejected"), status: "failed" }]
  const client = await createVercelQueueClient({
    client: { handleCallback: vi.fn(), send: vi.fn(), sendBatch: vi.fn(async () => results) },
    driver: "vercel",
    region: "iad1",
    topic: "welcome",
  } as never)
  const [error] = await client.sendBatch([{ body: 1 }, { body: 2 }])
  expect(error?.cause).toMatchObject({ code: "QUEUE_VERCEL_BATCH_REJECTED", results, message: "@vercel/queue did not accept 1 of 2 batch messages." })
})
