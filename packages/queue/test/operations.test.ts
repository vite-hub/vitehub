import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ViteHubError } from "@vite-hub/runtime"
import { afterEach, describe, expect, it, vi } from "vitest"

import { queueErrorDiagnostics } from "../src/error-diagnostics.ts"
import { queueOperations } from "../src/operations.ts"
import { closeLocalQueues, createLocalQueueRuntimeClient, startLocalQueue } from "../src/internal/runtime/local-client.ts"
import { setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/internal/runtime/state.ts"
import { createVercelQueueClient } from "../src/providers/vercel.ts"

import { operationCliPath } from "@vite-hub/internal/operations"

import type { OperationContext } from "@vite-hub/internal/operations"

const context: OperationContext = { access: { mode: "local", sections: "all" }, surface: "cli", user: null }
const registry = { welcome: async () => ({ handler: async () => {} }), digest: async () => ({ handler: async () => {} }) }

function operation(name: string) {
  const found = queueOperations.find(candidate => candidate.name === name)
  if (!found) throw new TypeError(`No operation ${name}.`)
  return found
}

function run(name: string, input: unknown): unknown {
  return Promise.resolve((operation(name).run as (input: unknown, context: OperationContext) => unknown)(input, context))
}

afterEach(() => {
  setQueueRuntimeConfig(undefined)
  setQueueRuntimeRegistry(undefined)
})

describe("queue operations", () => {
  it("names the list, send, and job operations in the queues section", () => {
    expect(queueOperations.map(({ invoke, kind, name, section }) => ({ invoke, kind, name, section }))).toEqual([
      { invoke: undefined, kind: "read", name: "queue.list", section: "queues" },
      { invoke: true, kind: "write", name: "queue.send", section: "queues" },
      { invoke: undefined, kind: "read", name: "queue.jobs-list", section: "queues" },
      { invoke: undefined, kind: "read", name: "queue.jobs-show", section: "queues" },
      { invoke: true, kind: "write", name: "queue.jobs-retry", section: "queues" },
      { invoke: undefined, kind: "destructive", name: "queue.jobs-clear", section: "queues" },
    ])
  })

  it("keeps the CLI commands under `vitehub queue`", () => {
    expect(queueOperations.map(operation => operationCliPath(operation))).toEqual([
      { command: "list", namespace: "queue" },
      { command: "send", namespace: "queue" },
      { command: "jobs list", namespace: "queue" },
      { command: "jobs show", namespace: "queue" },
      { command: "jobs retry", namespace: "queue" },
      { command: "jobs clear", namespace: "queue" },
    ])
  })

  it("lists the Queue Definitions and the provider", async () => {
    setQueueRuntimeConfig({ provider: "vercel", region: "iad1" } as never, vi.fn())
    setQueueRuntimeRegistry(registry)

    await expect(run("queue.list", {})).resolves.toEqual({ provider: "vercel", queues: [{ name: "digest" }, { name: "welcome" }] })
  })

  it("fails to list when Queue is disabled", async () => {
    setQueueRuntimeConfig(false)

    await expect(run("queue.list", {})).rejects.toMatchObject({ code: "QUEUE_DISABLED", status: 409, fix: queueErrorDiagnostics.QUEUE_DISABLED().fix })
  })

  it("sends one job through the provider client", async () => {
    const send = vi.fn(async () => ({ messageId: "message-1" }))
    setQueueRuntimeConfig(
      { provider: "vercel", region: "iad1" } as never,
      async () => await createVercelQueueClient({ client: { handleCallback: () => async () => new Response(), send }, provider: "vercel", topic: "welcome" }),
    )
    setQueueRuntimeRegistry(registry)

    await expect(run("queue.send", { delaySeconds: 5, payload: { userId: 7 }, queue: "welcome" })).resolves.toEqual({
      messageId: "message-1",
      provider: "vercel",
      queue: "welcome",
      status: "queued",
    })
    expect(send).toHaveBeenCalledWith("welcome", { userId: 7 }, expect.objectContaining({ delaySeconds: 5 }))
  })

  it("fails for a Queue Definition that does not exist", async () => {
    setQueueRuntimeConfig({ provider: "vercel", region: "iad1" } as never, vi.fn())
    setQueueRuntimeRegistry(registry)

    await expect(run("queue.send", { payload: {}, queue: "missing" })).rejects.toMatchObject({ code: "QUEUE_DEFINITION_NOT_FOUND", status: 404 })
  })

  it("reports a provider failure with its code", async () => {
    const send = vi.fn(async () => { throw new Error("provider down") })
    setQueueRuntimeConfig(
      { provider: "vercel", region: "iad1" } as never,
      async () => await createVercelQueueClient({ client: { handleCallback: () => async () => new Response(), send }, provider: "vercel", topic: "welcome" }),
    )
    setQueueRuntimeRegistry(registry)

    await expect(run("queue.send", { payload: {}, queue: "welcome" })).rejects.toMatchObject({ code: "QUEUE_PROVIDER_FAILED", status: 502 })
  })

  it("rejects a name that is not a safe identifier", async () => {
    setQueueRuntimeConfig({ provider: "vercel", region: "iad1" } as never, vi.fn())
    setQueueRuntimeRegistry(registry)

    await expect(run("queue.send", { payload: {}, queue: "../welcome" })).rejects.toMatchObject({ code: "QUEUE_INVALID_NAME", status: 400 })
  })
})

describe("queue job operations", () => {
  let base: string | undefined

  afterEach(async () => {
    closeLocalQueues()
    vi.restoreAllMocks()
    if (base) await rm(base, { force: true, recursive: true })
    base = undefined
  })

  async function installDev(handler: (job: { attempts: number, payload: unknown }) => unknown, development = true) {
    base = await mkdtemp(join(tmpdir(), "vitehub-queue-jobs-"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    // The config that the generated plugin installs in `vite dev` for a Cloudflare app.
    const config = { base, ...(development ? { development } : {}), provider: "local", rules: "cloudflare" } as const
    setQueueRuntimeConfig(config, createLocalQueueRuntimeClient)
    setQueueRuntimeRegistry({ welcome: async () => ({ handler }) })
    startLocalQueue(config)
  }

  it("lists a dead job with its error, shows its payload, retries it, and clears jobs", async () => {
    let fail = true
    const handler = vi.fn(async () => {
      // A `ViteHubError` keeps its code and message in the report. Other errors report a fixed message.
      if (fail) throw new ViteHubError("WELCOME_REJECTED", "Mailer rejected the address.")
    })
    await installDev(handler)

    const sent = await run("queue.send", { payload: { email: "ada@example.com" }, queue: "welcome" }) as { messageId: string, provider: string }
    expect(sent).toMatchObject({ messageId: expect.stringMatching(/^queue_/), provider: "local" })
    const id = sent.messageId
    // Cloudflare rules: 4 attempts, and a retry runs at once.
    await vi.waitFor(async () => {
      expect(await run("queue.jobs-list", {})).toMatchObject({ jobs: [{ attempts: 4, id, state: "dead" }] })
    })
    expect(handler).toHaveBeenCalledTimes(4)
    await expect(run("queue.list", {})).resolves.toMatchObject({ provider: "local", queues: [{ dead: 1, name: "welcome" }], rules: "cloudflare" })
    await expect(run("queue.jobs-list", { state: "pending" })).resolves.toMatchObject({ jobs: [], provider: "local", rules: "cloudflare" })
    await expect(run("queue.jobs-show", { id })).resolves.toMatchObject({
      job: { error: { code: "WELCOME_REJECTED", message: "Mailer rejected the address." }, id, payload: { email: "ada@example.com" }, queue: "welcome", state: "dead" },
    })

    fail = false
    await expect(run("queue.jobs-retry", { id })).resolves.toMatchObject({ job: { attempts: 0, id } })
    await vi.waitFor(async () => {
      expect(await run("queue.jobs-list", {})).toMatchObject({ jobs: [] })
    })
    expect(handler).toHaveBeenCalledTimes(5)
    expect(handler).toHaveBeenLastCalledWith({ attempts: 1, id, payload: { email: "ada@example.com" } })

    const { messageId: later } = await run("queue.send", { delaySeconds: 3600, payload: {}, queue: "welcome" }) as { messageId: string }
    await expect(run("queue.jobs-list", {})).resolves.toMatchObject({ jobs: [{ id: later, state: "pending" }] })
    await expect(run("queue.jobs-clear", { state: "dead" })).resolves.toEqual({ cleared: 0 })
    await expect(run("queue.jobs-clear", {})).resolves.toEqual({ cleared: 1 })
    await expect(run("queue.jobs-show", { id: later })).rejects.toMatchObject({ code: "QUEUE_JOB_NOT_FOUND", status: 404 })
  })

  it("shows the message and stack of a plain Error in `vite dev`", async () => {
    await installDev(async () => { throw new Error("SMTP down") })

    const { messageId: id } = await run("queue.send", { payload: {}, queue: "welcome" }) as { messageId: string }
    await vi.waitFor(async () => {
      expect(await run("queue.jobs-list", {})).toMatchObject({ jobs: [{ id, state: "dead" }] })
    })
    const shown = await run("queue.jobs-show", { id }) as { job: { error?: { message: string, stack?: string } } }
    expect(shown.job.error).toMatchObject({ message: "SMTP down", name: "Error" })
    expect(shown.job.error?.stack).toContain("operations.test.ts")
    const format = operation("queue.jobs-show").cli?.format as (result: unknown) => string
    expect(format(shown)).toContain("Error: SMTP down\nStack:\nError: SMTP down\n    at ")
  })

  it("keeps the fixed message for a plain Error outside `vite dev`", async () => {
    await installDev(async () => { throw new Error("SMTP down for ada@example.com") }, false)

    const { messageId: id } = await run("queue.send", { payload: {}, queue: "welcome" }) as { messageId: string }
    await vi.waitFor(async () => {
      expect(await run("queue.jobs-list", {})).toMatchObject({ jobs: [{ id, state: "dead" }] })
    })
    const shown = await run("queue.jobs-show", { id }) as { job: { error?: unknown } }
    expect(shown.job.error).toEqual({ message: "[vitehub] Queue Delivery failed.", name: "Error" })
  })

  it("runs a delayed job now on retry", async () => {
    const handler = vi.fn(async () => {})
    await installDev(handler)

    const { messageId: id } = await run("queue.send", { delaySeconds: 3600, payload: {}, queue: "welcome" }) as { messageId: string }
    await run("queue.jobs-retry", { id })
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
  })

  it("fails with a reason on a hosted provider, which does not let the app read its jobs", async () => {
    setQueueRuntimeConfig({ provider: "vercel", region: "iad1" } as never, vi.fn())

    await expect(run("queue.jobs-list", {})).rejects.toMatchObject({ code: "QUEUE_JOBS_UNAVAILABLE", status: 409 })
    await expect(run("queue.jobs-retry", { id: "job-1" })).rejects.toMatchObject({ code: "QUEUE_JOBS_UNAVAILABLE", status: 409 })
  })
})
