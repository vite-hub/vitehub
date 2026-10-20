import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { defineChannel, defineChannelTrigger, ignored, rejected, retryLater } from "@vite-hub/agent/channels"
import { github } from "../src/channels.ts"
import { defineAgent, runAgentTrigger } from "../src/index.ts"
import { createAgentRuntimeContext } from "../src/runtime/context.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

describe("ignored()", () => {
  it("answers HTTP 200 with the reason and accepted: false", async () => {
    const response = ignored("not_mine")
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ accepted: false, ok: true, reason: "not_mine" })
  })

  it("stops a Channel trigger without starting an Invocation", async () => {
    const run = vi.fn(() => "ok")
    const agent = defineAgent({
      channels: {
        tickets: defineChannel("tickets", {
          messages: false,
          triggers: {
            opened: defineChannelTrigger({
              invoke: (_context, event: { bot: boolean }) => event.bot ? ignored("bot_ticket") : { input: { prompt: "triage" } },
            }),
          },
        }),
      },
      driver: { run },
    })
    const runtime = { ...createAgentRuntimeContext({ runtime: "unknown", waitUntil: vi.fn() }), capabilities: {} }

    const response = await runAgentTrigger(agent, runtime, "tickets.opened", { bot: true })
    expect(response).toBeInstanceOf(Response)
    await expect((response as Response).json()).resolves.toEqual({ accepted: false, ok: true, reason: "bot_ticket" })
    expect(run).not.toHaveBeenCalled()
    await expect(runAgentTrigger(agent, runtime, "tickets.opened", { bot: false })).resolves.toBe("ok")
  })
})

describe("retryLater() and rejected()", () => {
  it.each([
    ["retryLater", retryLater, 503],
    ["rejected", rejected, 400],
  ] as const)("%s() answers its status with the reason and ok: false", async (_name, helper, status) => {
    const response = helper("dependency_down")
    expect(response.status).toBe(status)
    expect(response.headers.get("content-type")).toContain("application/json")
    await expect(response.json()).resolves.toEqual({ accepted: false, ok: false, reason: "dependency_down" })
  })

  it.each([
    ["retryLater", retryLater, 503, "failed"],
    ["rejected", rejected, 400, "rejected"],
  ] as const)("the webhook route answers %s() to the sender without an Invocation", async (_name, helper, status, deliveryStatus) => {
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-channel-answer-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const run = vi.fn(() => "ok")
    const agent = defineAgent({
      channels: {
        tickets: defineChannel("tickets", {
          messages: false,
          triggers: { webhook: defineChannelTrigger({ invoke: () => helper("ticketing_down") }) },
          webhooks: { path: "/api/tickets/webhook", secretToken: false },
        }),
      },
      driver: { run },
    })
    await state.connect()
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    const handler = createChannelWebhookRouteHandler(agent as never)
    const options = { agentName: "support", webhookState: state }
    const request = () => new Request("https://example.com/api/tickets/webhook", {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    try {
      const response = await handler(request(), "tickets", options)
      expect(response.status).toBe(status)
      await expect(response.json()).resolves.toEqual({ accepted: false, ok: false, reason: "ticketing_down" })
      expect(run).not.toHaveBeenCalled()
      await vi.waitFor(async () => {
        const [delivery] = await handler.deliveries(request(), "tickets", options)
        expect(delivery?.status).toBe(deliveryStatus)
      })
    }
    finally {
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
    }
  })

  it.each(["retryLater", "rejected"] as const)("the webhook queue settles %s() from a queued delivery", async (name) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-channel-queue-answer-"))
    const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
    const complete = vi.spyOn(state, "completeWebhookDelivery")
    const retry = vi.spyOn(state, "retryWebhookDelivery")
    const failed = vi.fn()
    const run = vi.fn(() => "unexpected Invocation")
    const rehydrate = vi.fn(() => name === "retryLater" ? retryLater("ticketing_down") : rejected("ticket_deleted"))
    const agent = defineAgent({
      channels: {
        github: github({
          triggers: {
            webhook: {
              failed,
              invoke: () => ({
                input: { prompt: "saved source data" },
                webhook: { concurrencyLimit: 1, deliveryId: "delivery-answer", rehydrate },
              }),
            },
          },
          webhooks: { secretToken: false },
        }),
      },
      driver: { run },
    })
    await state.connect()
    // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
    const handler = createChannelWebhookRouteHandler(agent as never)
    const options = { agentName: "review", webhookState: state }
    const stop = handler.resume(options)
    const request = () => new Request("https://example.com/api/github/webhook", {
      body: "{}",
      headers: { "content-type": "application/json", "x-github-delivery": "delivery-answer", "x-github-event": "pull_request" },
      method: "POST",
    })
    try {
      expect((await handler(request(), "github", options)).status).toBe(200)
      // Three attempts with the queue backoff take about 5 seconds.
      await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce(), { timeout: 10_000 })
      await Promise.all(complete.mock.results.map(result => result.value))
      expect(run).not.toHaveBeenCalled()
      const delivery = (await handler.deliveries(request(), "github", options)).find(item => item.sourceId === "delivery-answer")
      if (name === "retryLater") {
        expect(rehydrate).toHaveBeenCalledTimes(3)
        expect(retry).toHaveBeenCalledTimes(2)
        expect(failed).toHaveBeenCalledOnce()
        expect(failed.mock.calls[0]?.[0].error).toMatchObject({ message: expect.stringContaining("HTTP 503 (ticketing_down)") })
        expect(delivery?.status).toBe("failed")
      }
      else {
        expect(rehydrate).toHaveBeenCalledOnce()
        expect(retry).not.toHaveBeenCalled()
        expect(failed).not.toHaveBeenCalled()
        expect(delivery?.status).toBe("rejected")
      }
    }
    finally {
      await stop()
      await state.disconnect()
      await rm(stateDir, { force: true, recursive: true })
      consoleError.mockRestore()
    }
  }, 15_000)
})
