import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { normalizeQueueOptions } from "../src/config.ts"
import { queueErrorDiagnostics } from "../src/error-diagnostics.ts"
import { closeLocalQueues, startLocalQueue } from "../src/internal/runtime/local-client.ts"
import { missingQueueDefinitionError, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/internal/runtime/state.ts"
import { createLocalQueueClient, createLocalQueueEngine, localQueueDeadLimit, localQueueMaxAttempts } from "../src/providers/local.ts"
import { dynamicQueue } from "../src/runtime/client.ts"
import { createQueueClient } from "../src/runtime/create-client.ts"
import { listQueues } from "../src/runtime/operations.ts"
import { createLocalQueueRuntimeClient } from "../src/internal/runtime/local-client.ts"

import type { QueueDefinition, QueueJob } from "../src/types.ts"

// Pass-through mocks, so a test can fail one disk write or delete.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, rm: vi.fn(actual.rm), writeFile: vi.fn(actual.writeFile) }
})

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "vitehub-queue-local-"))
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(async () => {
  closeLocalQueues()
  setQueueRuntimeConfig(undefined)
  setQueueRuntimeRegistry(undefined)
  vi.restoreAllMocks()
  await rm(base, { force: true, recursive: true })
})

async function storedJobs() {
  const names = (await readdir(base)).filter(name => name.endsWith(".json"))
  return await Promise.all(names.map(async name => JSON.parse(await readFile(join(base, name), "utf8")) as { attempts: number, state: string, error?: { code?: string } }))
}

function engineFor(definitions: Record<string, QueueDefinition>, retryDelayMs = () => 0) {
  return createLocalQueueEngine({
    base,
    load: async name => definitions[name],
    missing: missingQueueDefinitionError,
    retryDelayMs,
  })
}

function install(definitions: Record<string, QueueDefinition>) {
  setQueueRuntimeConfig(normalizeQueueOptions({ base }, { hosting: "node-server" })!, createLocalQueueRuntimeClient)
  setQueueRuntimeRegistry(Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, async () => definition])))
  startLocalQueue(normalizeQueueOptions({ base }, { hosting: "node-server" })!)
}

describe("local queue provider config", () => {
  it("is the default provider for a Node server", () => {
    expect(normalizeQueueOptions(undefined, { hosting: "node-server" })).toEqual({ base: ".vitehub/data/queue", provider: "local" })
    expect(normalizeQueueOptions({ provider: "local", base: " data/jobs " })).toEqual({ base: "data/jobs", provider: "local" })
  })

  it("keeps Vercel and Cloudflare inference", () => {
    expect(normalizeQueueOptions(undefined, { hosting: "vercel" })).toEqual({ provider: "vercel" })
    expect(normalizeQueueOptions(undefined, { hosting: "cloudflare" })).toEqual({ provider: "cloudflare" })
    expect(normalizeQueueOptions(undefined)).toEqual({ provider: "vercel" })
  })
})

describe("local queue delivery", () => {
  it("runs the Queue Definition after runQueue() accepts the job", async () => {
    const handler = vi.fn(async (_job: QueueJob) => {})
    install({ welcome: { handler } })

    const [error, result] = await dynamicQueue.run("welcome", { at: new Date(0), email: "ada@example.com" }, { id: "job-1" })

    expect(error).toBeUndefined()
    expect(result).toEqual({ messageId: "job-1", status: "queued" })
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    // The handler gets the stored JSON copy, as it does from a hosted provider.
    expect(handler).toHaveBeenCalledWith({ attempts: 1, id: "job-1", payload: { at: "1970-01-01T00:00:00.000Z", email: "ada@example.com" } })
    await vi.waitFor(async () => expect(await storedJobs()).toEqual([]))
  })

  it("logs once where it stores the jobs", () => {
    install({ welcome: { handler: async () => {} } })

    expect(console.warn).toHaveBeenCalledOnce()
    expect(vi.mocked(console.warn).mock.calls[0]![0]).toContain(`stores jobs in ${base}`)
    expect(vi.mocked(console.warn).mock.calls[0]![0]).toContain("not a move to another host or a new container")
  })

  it("waits for delaySeconds", async () => {
    const handler = vi.fn(async () => {})
    install({ welcome: { handler } })
    const queue = await dynamicQueue.get("welcome")

    const started = Date.now()
    await queue.send({}, { delaySeconds: 0.3 })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(handler).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    expect(Date.now() - started).toBeGreaterThanOrEqual(290)
  })

  it("retries a failed job, then keeps it as a dead job", async () => {
    const handler = vi.fn(async (_job: QueueJob) => { throw new Error("SMTP down") })
    const engine = engineFor({ welcome: { handler } })

    await engine.enqueue("welcome", [{ id: "job-1", payload: {} }])

    await vi.waitFor(async () => expect((await engine.status()).queues.welcome).toEqual({ dead: 1, pending: 0, running: 0 }))
    expect(handler).toHaveBeenCalledTimes(localQueueMaxAttempts)
    expect(handler.mock.calls.map(([job]) => job.attempts)).toEqual([1, 2, 3, 4])
    expect(await storedJobs()).toEqual([expect.objectContaining({ attempts: 4, state: "dead" })])
  })

  it("does not retry a Queue error that a retry cannot fix", async () => {
    const handler = vi.fn(async () => { throw queueErrorDiagnostics.QUEUE_DISABLED() })
    const engine = engineFor({ welcome: { handler } })

    await engine.enqueue("welcome", [{ id: "job-1", payload: {} }])

    await vi.waitFor(async () => expect((await engine.status()).queues.welcome?.dead).toBe(1))
    expect(handler).toHaveBeenCalledOnce()
    expect(await storedJobs()).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: "QUEUE_DISABLED" }), state: "dead" })])
  })

  it("keeps a job for a missing Queue Definition as a dead job", async () => {
    const engine = engineFor({})

    await engine.enqueue("gone", [{ id: "job-1", payload: {} }])

    await vi.waitFor(async () => expect((await engine.status()).queues.gone?.dead).toBe(1))
  })

  it("runs one job at a time unless the definition sets concurrency", async () => {
    let active = 0
    let peak = 0
    const handler = async () => {
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 20))
      active--
    }
    const engine = engineFor({ one: { handler }, three: { handler, options: { concurrency: 3 } } })

    await engine.enqueue("one", [1, 2, 3, 4].map(n => ({ id: `job-${n}`, payload: n })))
    await vi.waitFor(async () => expect((await engine.status()).queues).toEqual({}))
    expect(peak).toBe(1)

    peak = 0
    await engine.enqueue("three", [1, 2, 3, 4, 5, 6].map(n => ({ id: `job-${n}`, payload: n })))
    await vi.waitFor(async () => expect((await engine.status()).queues).toEqual({}))
    expect(peak).toBe(3)
  })
})

describe("local queue durability", () => {
  it("delivers a job that was waiting when the process stopped", async () => {
    const first = engineFor({ welcome: { handler: async () => { throw new Error("the first process must not deliver it") } } })
    await first.enqueue("welcome", [{ delaySeconds: 0.2, id: "job-1", payload: { email: "ada@example.com" } }])
    first.close()

    const handler = vi.fn(async () => {})
    const second = engineFor({ welcome: { handler } })
    expect((await second.status()).queues.welcome).toEqual({ dead: 0, pending: 1, running: 0 })

    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith({ attempts: 1, id: "job-1", payload: { email: "ada@example.com" } }))
    await vi.waitFor(async () => expect(await storedJobs()).toEqual([]))
  })

  it("delivers a job again when the process stopped during its handler", async () => {
    const stuck = vi.fn(() => new Promise(() => {}))
    const first = engineFor({ welcome: { handler: stuck } })
    await first.enqueue("welcome", [{ id: "job-1", payload: {} }])
    await vi.waitFor(() => expect(stuck).toHaveBeenCalledOnce())
    expect((await first.status()).queues.welcome?.running).toBe(1)
    first.close()

    const handler = vi.fn(async () => {})
    const second = engineFor({ welcome: { handler } })
    await second.start()

    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(expect.objectContaining({ attempts: 2, id: "job-1" })))
  })

  it("keeps dead jobs after a restart", async () => {
    const first = engineFor({ welcome: { handler: async () => { throw queueErrorDiagnostics.QUEUE_DISABLED() } } })
    await first.enqueue("welcome", [{ id: "job-1", payload: {} }])
    await vi.waitFor(async () => expect((await first.status()).queues.welcome?.dead).toBe(1))
    first.close()

    const handler = vi.fn(async () => {})
    const second = engineFor({ welcome: { handler } })

    expect((await second.status()).queues.welcome).toEqual({ dead: 1, pending: 0, running: 0 })
    expect(handler).not.toHaveBeenCalled()
  })
})

describe("local queue client", () => {
  it("returns the stored message ID for a repeated idempotencyKey", async () => {
    const handler = vi.fn(async () => {})
    const engine = engineFor({ welcome: { handler } }, () => 60_000)
    const client = createLocalQueueClient(engine, "welcome")

    const [, first] = await client.send({ n: 1 }, { delaySeconds: 60, idempotencyKey: "signup-ada" })
    const [, second] = await client.send({ n: 2 }, { idempotencyKey: "signup-ada" })

    expect(second?.messageId).toBe(first?.messageId)
    expect((await engine.status()).queues.welcome?.pending).toBe(1)
  })

  it("rejects options that only a hosted provider has", async () => {
    const client = createLocalQueueClient(engineFor({}), "welcome")

    const [error] = await client.send({}, { contentType: "json", region: "iad1" })

    expect(error).toMatchObject({ code: "QUEUE_UNSUPPORTED_OPTION", why: "The local queue provider does not support the enqueue option `contentType` and `region`." })
    expect(await storedJobs()).toEqual([])
  })

  it("returns QUEUE_PROVIDER_FAILED for a payload that is not JSON", async () => {
    const client = createLocalQueueClient(engineFor({}), "welcome")

    const [error] = await client.send({ id: 1n })

    expect(error).toMatchObject({ code: "QUEUE_PROVIDER_FAILED", why: "The local queue provider failed during send." })
  })

  it("sends a batch", async () => {
    const handler = vi.fn(async () => {})
    const client = createLocalQueueClient(engineFor({ welcome: { handler } }), "welcome")

    const [error, results] = await client.sendBatch([{ body: 1 }, { body: 2, delaySeconds: 0 }])

    expect(error).toBeUndefined()
    expect(results).toEqual([{ messageId: expect.stringMatching(/^queue_/), status: "queued" }, { messageId: expect.stringMatching(/^queue_/), status: "queued" }])
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
  })

  it("needs a queue name for a direct client", async () => {
    await expect(createQueueClient({ provider: "local", base })).rejects.toMatchObject({ code: "QUEUE_MISSING_QUEUE" })
    await expect(createQueueClient({ provider: "local", base, queue: "welcome" })).resolves.toMatchObject({ provider: "local", queue: "welcome" })
  })
})

describe("local queue inspection", () => {
  it("lists the storage, its durability, and the job counts", async () => {
    install({ digest: { handler: async () => {} }, welcome: { handler: async () => {} } })
    await dynamicQueue.run("welcome", {}, { delaySeconds: 60 })

    await expect(listQueues()).resolves.toEqual({
      provider: "local",
      queues: [{ dead: 0, name: "digest", pending: 0, running: 0 }, { dead: 0, name: "welcome", pending: 1, running: 0 }],
      storage: { base, deadLimit: 100, durability: "single-host" },
    })
  })
})

describe("local queue review regressions", () => {
  it("waits for a failed reservation before accepting an overlapping idempotent send", async () => {
    const handler = vi.fn(async () => {})
    const engine = engineFor({ welcome: { handler } })
    const client = createLocalQueueClient(engine, "welcome")
    await engine.start()
    let rejectWrite!: (error: Error) => void
    let writing!: () => void
    const started = new Promise<void>(resolve => { writing = resolve })
    vi.mocked(writeFile).mockImplementationOnce(() => {
      writing()
      return new Promise((_, reject) => { rejectWrite = reject })
    })

    const first = client.send(1, { idempotencyKey: "signup-ada" })
    await started
    let accepted = false
    const second = client.send(2, { idempotencyKey: "signup-ada" }).then(result => {
      accepted = !result[0]
      return result
    })
    await setImmediate()
    const acceptedBeforePersistence = accepted
    rejectWrite(new Error("ENOSPC: no space left on device"))

    const [[firstError], [secondError, sent]] = await Promise.all([first, second])
    expect(firstError).toMatchObject({ code: "QUEUE_PROVIDER_FAILED" })
    expect(acceptedBeforePersistence).toBe(false)
    expect(secondError).toBeUndefined()
    expect(sent?.status).toBe("queued")
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(expect.objectContaining({ payload: 2 })))
    await vi.waitFor(async () => expect(await storedJobs()).toEqual([]))
    engine.close()
  })

  it("deduplicates repeated keys within a batch", async () => {
    const handler = vi.fn(async () => {})
    const engine = engineFor({ welcome: { handler } })
    const client = createLocalQueueClient(engine, "welcome")

    const [error, sent] = await client.sendBatch([
      { body: 1, idempotencyKey: "signup-ada" },
      { body: 2, idempotencyKey: "signup-ada" },
      { body: 3, idempotencyKey: "signup-grace" },
    ], { delaySeconds: 60 })

    engine.close()
    expect(error).toBeUndefined()
    expect(sent?.[1].messageId).toBe(sent?.[0].messageId)
    expect(sent?.[2].messageId).not.toBe(sent?.[0].messageId)
    expect(await storedJobs()).toHaveLength(2)
    expect(handler).not.toHaveBeenCalled()
  })

  it("does not consume attempts when the pre-handler write fails", async () => {
    const handler = vi.fn(async () => {})
    const engine = engineFor({ welcome: { handler } })
    const actual = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).writeFile
    let failures = 0
    vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
      const job = JSON.parse(String(data)) as { attempts: number, state: string }
      if (job.state === "pending" && job.attempts > 0 && failures < localQueueMaxAttempts + 1) {
        failures++
        throw new Error("ENOSPC: no space left on device")
      }
      return await actual(path, data, options)
    })

    await engine.enqueue("welcome", [{ id: "job-1", payload: {} }])

    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1 })))
    expect(failures).toBe(localQueueMaxAttempts + 1)
    await vi.waitFor(async () => expect(await storedJobs()).toEqual([]))
    engine.close()
  })

  it("runs one job for overlapping sends with the same idempotencyKey", async () => {
    const handler = vi.fn(async () => {})
    const client = createLocalQueueClient(engineFor({ welcome: { handler } }), "welcome")

    const [[, first], [, second]] = await Promise.all([
      client.send({ n: 1 }, { idempotencyKey: "signup-ada" }),
      client.send({ n: 2 }, { idempotencyKey: "signup-ada" }),
    ])

    expect(second?.messageId).toBe(first?.messageId)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(handler).toHaveBeenCalledOnce()
  })

  it("does not run a job again that stopped the process on its last attempt", async () => {
    // Each engine is a process that dies during the handler.
    for (let attempt = 1; attempt <= localQueueMaxAttempts; attempt++) {
      const stuck = vi.fn(() => new Promise(() => {}))
      const engine = engineFor({ welcome: { handler: stuck } })
      if (attempt === 1) await engine.enqueue("welcome", [{ id: "job-1", payload: {} }])
      else await engine.start()
      await vi.waitFor(() => expect(stuck).toHaveBeenCalledWith(expect.objectContaining({ attempts: attempt })))
      engine.close()
    }

    const handler = vi.fn(async () => {})
    const last = engineFor({ welcome: { handler } })

    await vi.waitFor(async () => expect((await last.status()).queues.welcome).toEqual({ dead: 1, pending: 0, running: 0 }))
    await vi.waitFor(async () => expect(await storedJobs()).toEqual([expect.objectContaining({ attempts: localQueueMaxAttempts, error: expect.objectContaining({ message: "[vitehub] The process stopped during the last attempt of this job." }), state: "dead" })]))
    expect(handler).not.toHaveBeenCalled()
  })

  it("accepts a new job when the job with the same idempotencyKey is dead", async () => {
    let fail = true
    const handler = vi.fn(async () => { if (fail) throw queueErrorDiagnostics.QUEUE_DISABLED() })
    const engine = engineFor({ welcome: { handler } })
    const client = createLocalQueueClient(engine, "welcome")

    const [, first] = await client.send({}, { idempotencyKey: "signup-ada" })
    await vi.waitFor(async () => expect((await engine.status()).queues.welcome?.dead).toBe(1))
    fail = false
    const [, second] = await client.send({}, { idempotencyKey: "signup-ada" })

    expect(second?.messageId).not.toBe(first?.messageId)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
    await vi.waitFor(async () => expect((await engine.status()).queues.welcome).toEqual({ dead: 1, pending: 0, running: 0 }))
  })

  it("stores no job of a batch when one file cannot be written", async () => {
    const handler = vi.fn(async () => {})
    const engine = engineFor({ welcome: { handler } })
    const client = createLocalQueueClient(engine, "welcome")
    await engine.start()
    const actual = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).writeFile
    vi.mocked(writeFile)
      .mockImplementationOnce(actual)
      .mockImplementationOnce(async () => { throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }) })

    const [error] = await client.sendBatch([{ body: 1 }, { body: 2 }])

    expect(error).toMatchObject({ code: "QUEUE_PROVIDER_FAILED" })
    expect(await readdir(base)).toEqual([])
    expect((await engine.status()).queues).toEqual({})

    const [retryError] = await client.sendBatch([{ body: 1 }, { body: 2 }])
    expect(retryError).toBeUndefined()
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
  })

  it("does not run a finished job again when its file cannot be deleted", async () => {
    const handler = vi.fn(async () => {})
    const engine = engineFor({ welcome: { handler } })
    await engine.start()
    const actual = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rm
    let failed = false
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (!failed && String(path).endsWith(".json")) {
        failed = true
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" })
      }
      return await actual(path, options)
    })

    await engine.enqueue("welcome", [{ id: "job-1", payload: {} }])

    await vi.waitFor(async () => expect(await storedJobs()).toEqual([expect.objectContaining({ state: "done" })]))
    expect(handler).toHaveBeenCalledOnce()
    expect((await engine.status()).queues).toEqual({})
    engine.close()
    vi.mocked(rm).mockImplementation(actual)

    const again = vi.fn(async () => {})
    const second = engineFor({ welcome: { handler: again } })
    await second.start()

    expect(await readdir(base)).toEqual([])
    expect(again).not.toHaveBeenCalled()
  })

  it("keeps the newest dead jobs up to the limit", async () => {
    const engine = engineFor({ welcome: { handler: async () => { throw queueErrorDiagnostics.QUEUE_DISABLED() } } })

    await engine.enqueue("welcome", Array.from({ length: localQueueDeadLimit + 5 }, (_, n) => ({ id: `job-${n}`, payload: n })))

    await vi.waitFor(async () => expect((await engine.status()).queues.welcome).toEqual({ dead: localQueueDeadLimit, pending: 0, running: 0 }), { timeout: 10_000 })
    expect((await storedJobs()).length).toBe(localQueueDeadLimit)
    engine.close()

    expect((await engineFor({}).status()).queues.welcome?.dead).toBe(localQueueDeadLimit)
  })

  it("redelivers after restart when neither completion operation can reach disk", async () => {
    const handler = vi.fn(async () => {})
    const engine = engineFor({ welcome: { handler } })
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    let completionFailed = false
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (String(path).endsWith(".json")) throw new Error("EIO: cannot delete job")
      return await actual.rm(path, options)
    })
    vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
      if ((JSON.parse(String(data)) as { state: string }).state === "done") {
        completionFailed = true
        throw new Error("EIO: cannot save completion")
      }
      return await actual.writeFile(path, data, options)
    })

    await engine.enqueue("welcome", [{ id: "job-1", payload: {} }])
    await vi.waitFor(() => expect(completionFailed).toBe(true))
    expect(handler).toHaveBeenCalledOnce()
    expect(await storedJobs()).toEqual([expect.objectContaining({ attempts: 1, state: "pending" })])
    engine.close()
    vi.mocked(rm).mockImplementation(actual.rm)
    vi.mocked(writeFile).mockImplementation(actual.writeFile)

    const second = engineFor({ welcome: { handler } })
    await second.start()
    await vi.waitFor(() => expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({ attempts: 2 })))
    await vi.waitFor(async () => expect(await storedJobs()).toEqual([]))
    second.close()
  })
})
