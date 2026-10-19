import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineChannel, defineChannelTrigger, github } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { createAgentRuntimeContext } from "../src/runtime/context.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"
import { resolveAgentTriggerInvocation } from "../src/trigger-runtime.ts"
import type { AgentTriggerRunInvokeResult, ResolvedAgentRuntimeContext } from "../src/types.ts"

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe("webhook deliveryId default", () => {
  function agentWith(result: AgentTriggerRunInvokeResult) {
    return defineAgent({
      channels: {
        tickets: defineChannel("tickets", {
          messages: false,
          triggers: { opened: defineChannelTrigger({ invoke: () => result }) },
        }),
      },
      driver: { run: () => "ok" },
    })
  }

  const runtime: ResolvedAgentRuntimeContext = { ...createAgentRuntimeContext({ runtime: "unknown", waitUntil: vi.fn() }), capabilities: {}, runtimeConfig: {} }
  const body = JSON.stringify({ ticket: 42 })

  it("is the SHA-256 of the raw body, and the run uses it", async () => {
    const resolved = await resolveAgentTriggerInvocation(agentWith({
      input: { prompt: "triage" },
      webhook: { serialize: "ticket:42" },
    }), runtime, "tickets.opened", {}, { rawBody: body })
    expect(resolved).toMatchObject({
      run: { channelId: "tickets", runId: sha256(body) },
      webhook: { concurrencyKey: "ticket:42", concurrencyLimit: 1, deliveryId: sha256(body) },
    })
  })

  it("keeps a deliveryId that the trigger sets", async () => {
    const resolved = await resolveAgentTriggerInvocation(agentWith({
      input: { prompt: "triage" },
      webhook: { concurrencyLimit: 1, deliveryId: "event-7" },
    }), runtime, "tickets.opened", {}, { rawBody: body })
    expect(resolved).toHaveProperty("webhook.deliveryId", "event-7")
  })

  it("is not set outside a webhook request", async () => {
    const resolved = await resolveAgentTriggerInvocation(agentWith({
      input: { prompt: "triage" },
      webhook: { concurrencyLimit: 1 },
    }), runtime, "tickets.opened", {})
    expect(resolved).not.toHaveProperty("webhook.deliveryId")
    expect(resolved).not.toHaveProperty("run.runId")
  })
})

describe("webhook route without deliveryId", () => {
  async function setup(rehydrate: boolean) {
    const stateDir = await mkdtemp(join(tmpdir(), "vitehub-webhook-body-delivery-id-"))
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
              invoke: () => ({
                input: { prompt: "check" },
                webhook: rehydrate
                  ? { concurrencyLimit: 1, rehydrate: () => ({ input: { prompt: "rehydrated" }, webhook: { concurrencyLimit: 1 } }) }
                  : { concurrencyLimit: 1 },
              }),
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
    const send = async (payload: string, providerDeliveryId: string) => await (await handler(new Request("https://example.com/api/github/webhook", {
      body: payload,
      headers: { "content-type": "application/json", "x-github-delivery": providerDeliveryId, "x-github-event": "pull_request" },
      method: "POST",
    }), "github", { agentName: "review", webhookState: state })).json()
    return { run, runIds, send }
  }

  it.each([false, true])("runs an identical retried body once, rehydrate: %s", async (rehydrate) => {
    const { run, runIds, send } = await setup(rehydrate)
    const first = JSON.stringify({ action: "opened", number: 1 })
    const second = JSON.stringify({ action: "opened", number: 2 })

    await expect(send(first, "a")).resolves.toMatchObject({ accepted: true, duplicate: false, queued: true })
    await expect(send(first, "b")).resolves.toMatchObject({ accepted: false, duplicate: true })
    await expect(send(second, "c")).resolves.toMatchObject({ accepted: true, queued: true })

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(runIds.sort()).toEqual([sha256(first), sha256(second)].sort())
  })
})
