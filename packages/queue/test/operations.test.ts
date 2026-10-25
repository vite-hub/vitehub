import { afterEach, describe, expect, it, vi } from "vitest"

import { queueOperations } from "../src/operations.ts"
import { setQueueRuntimeConfig, setQueueRuntimeRegistry } from "../src/internal/runtime/state.ts"
import { createVercelQueueClient } from "../src/providers/vercel.ts"

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
  it("names the list and send operations in the queues section", () => {
    expect(queueOperations.map(({ kind, name, section }) => ({ kind, name, section }))).toEqual([
      { kind: "read", name: "queue.list", section: "queues" },
      { kind: "write", name: "queue.send", section: "queues" },
    ])
  })

  it("lists the Queue Definitions and the provider", async () => {
    setQueueRuntimeConfig({ provider: "vercel", region: "iad1" } as never, vi.fn())
    setQueueRuntimeRegistry(registry)

    await expect(run("queue.list", {})).resolves.toEqual({ provider: "vercel", queues: [{ name: "digest" }, { name: "welcome" }] })
  })

  it("fails to list when Queue is disabled", async () => {
    setQueueRuntimeConfig(false)

    await expect(run("queue.list", {})).rejects.toMatchObject({ code: "QUEUE_DISABLED", status: 409 })
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
