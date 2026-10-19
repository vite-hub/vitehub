import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { github } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"
import type { AgentWebhookInvocationOwnership } from "../src/types.ts"

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(ownership: (deliveryId: string) => AgentWebhookInvocationOwnership) {
  const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-response-"))
  const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
  const enqueue = vi.spyOn(state, "enqueueWebhookDelivery")
  const run = vi.fn(() => "ok")
  const agent = defineAgent({
    channels: {
      github: github({
        triggers: {
          webhook: {
            invoke: (_context, input) => {
              // SAFETY: The GitHub Channel supplies the delivery header as github.deliveryId.
              const deliveryId = (input as { github: { deliveryId: string } }).github.deliveryId
              return { input: { prompt: "check" }, webhook: ownership(deliveryId) }
            },
          },
        },
        webhooks: { secretToken: false },
      }),
    },
    driver: { run },
  })
  // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
  const handler = createChannelWebhookRouteHandler(agent as never)
  const stop = handler.resume({ agentName: "review", webhookState: state })
  cleanups.push(async () => {
    stop()
    await state.disconnect()
    await rm(stateDir, { force: true, recursive: true })
  })
  const send = (deliveryId: string) => handler(new Request("https://example.com/api/github/webhook", {
    body: "{}",
    headers: { "content-type": "application/json", "x-github-delivery": deliveryId, "x-github-event": "pull_request" },
    method: "POST",
  }), "github", { agentName: "review", webhookState: state })
  return { enqueue, run, send }
}

describe("webhook.response", () => {
  it("answers a queued delivery after admission and never stores the answer", async () => {
    const { enqueue, run, send } = await setup(deliveryId => ({
      concurrencyLimit: 1,
      deliveryId,
      response: new Response(null, { status: 200 }),
    }))

    const response = await send("delivery-1")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("")
    expect(enqueue).toHaveBeenCalledOnce()
    const stored = enqueue.mock.calls[0]![0]
    expect(stored).toMatchObject({ deliveryId: "delivery-1" })
    expect(JSON.stringify(stored)).not.toContain("response")
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  })

  it("answers a duplicate delivery with the same response", async () => {
    const { enqueue, send } = await setup(deliveryId => ({
      concurrencyLimit: 1,
      debounce: { delayMs: 60_000, key: deliveryId },
      deliveryId,
      response: new Response("ok", { status: 202 }),
    }))

    await send("delivery-1")
    const duplicate = await send("delivery-1")
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(await enqueue.mock.results[1]!.value).toBe(false)
    expect(duplicate.status).toBe(202)
    expect(await duplicate.text()).toBe("ok")
  })

  it("answers an inline delivery after its claim", async () => {
    const { enqueue, run, send } = await setup(deliveryId => ({
      deliveryId,
      response: new Response(null, { status: 204 }),
    }))

    const response = await send("delivery-1")
    expect(response.status).toBe(204)
    expect(enqueue).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  })

  it("keeps the JSON receipt without a response", async () => {
    const { send } = await setup(deliveryId => ({ concurrencyLimit: 1, deliveryId }))

    const response = await send("delivery-1")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: true, duplicate: false, ok: true, queued: true })
  })

  it("rejects a response that is not a Response", async () => {
    const { enqueue, run, send } = await setup(deliveryId => ({
      concurrencyLimit: 1,
      deliveryId,
      // SAFETY: The types reject this value. The test checks the runtime guard for untyped callers.
      response: { status: 200 } as never,
    }))

    const response = await send("delivery-1")
    expect(response.status).toBe(500)
    expect(enqueue).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})
