import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { github } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(debounce: unknown) {
  const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-debounce-"))
  const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
  const runIds: Array<string | undefined> = []
  const run = vi.fn((context: { run?: { runId?: string } }) => {
    runIds.push(context.run?.runId)
    return "ok"
  })
  const agent = defineAgent({
    channels: {
      github: github({
        triggers: {
          webhook: {
            invoke: (_context, input) => {
              // SAFETY: The GitHub Channel supplies the delivery header as github.deliveryId.
              const deliveryId = (input as { github: { deliveryId: string } }).github.deliveryId
              return {
                input: { prompt: "check" },
                run: { runId: deliveryId },
                // SAFETY: Invalid debounce values are part of this test.
                webhook: { concurrencyLimit: 1, debounce: debounce as never, deliveryId },
              }
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
  return { run, runIds, send, state }
}

describe("webhook debounce", () => {
  it("waits delayMs before a queued delivery runs", async () => {
    vi.useFakeTimers()
    const { run, runIds, send } = await setup({ delayMs: 5_000, key: "pr-1" })

    await expect(send("delivery-1")).resolves.toMatchObject({ status: 200 })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(run).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3_000)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(runIds).toEqual(["delivery-1"])
  })

  it("runs only the latest delivery with the same key", async () => {
    vi.useFakeTimers()
    const { run, runIds, send, state } = await setup({ delayMs: 5_000, key: "pr-1" })
    const complete = vi.spyOn(state, "completeWebhookDelivery")

    await send("delivery-1")
    await vi.advanceTimersByTimeAsync(3_000)
    await send("delivery-2")
    await vi.advanceTimersByTimeAsync(3_000)
    expect(run).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(expect.any(String), "delivery-1", expect.any(String)))

    await vi.advanceTimersByTimeAsync(3_000)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(runIds).toEqual(["delivery-2"])
    expect(await state.webhookDeliveries((await state.webhookDeliveryScopes())[0] ?? "")).toEqual([])
  })

  it.each([
    { delayMs: -1, key: "pr-1" },
    { delayMs: 1.5, key: "pr-1" },
    { delayMs: 10, key: " " },
  ])("rejects the debounce option %j", async (debounce) => {
    const { run, send } = await setup(debounce)
    await expect(send("delivery-invalid")).rejects.toThrow("debounce needs a non-empty key and a non-negative integer delayMs")
    expect(run).not.toHaveBeenCalled()
  })
})
