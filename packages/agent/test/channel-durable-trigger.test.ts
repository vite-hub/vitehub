import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineChannel, defineChannelTrigger } from "../src/channels.ts"
import { defineAgent, resolveAgentTriggerInvocation } from "../src/index.ts"
import { createAgentRuntimeContext } from "../src/runtime/context.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"
import type { AgentChannelStateBinding, AgentTriggerInvokeResult } from "../src/types.ts"

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const runtime = { ...createAgentRuntimeContext({ runtime: "unknown", waitUntil: vi.fn() }), capabilities: {} }

function agentWith(
  durableState: boolean,
  invoke: (channelState: AgentChannelStateBinding | undefined) => AgentTriggerInvokeResult,
  webhooks: { secretToken: false, stateScope?: string } = { secretToken: false },
) {
  const seen = vi.fn(invoke)
  const run = vi.fn(() => "ok")
  const opened = durableState
    ? defineChannelTrigger({ durableState: true, invoke: context => seen(context.channelState) })
    : defineChannelTrigger({ invoke: context => seen(context.channelState) })
  const agent = defineAgent({
    channels: {
      tickets: defineChannel("tickets", {
        messages: false,
        triggers: { opened },
        webhooks,
      }),
    },
    driver: { run },
  })
  return { agent, run, seen }
}

async function routeFor(agent: ReturnType<typeof agentWith>["agent"]) {
  const stateDir = await mkdtemp(join(tmpdir(), "vitehub-durable-trigger-"))
  const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
  // SAFETY: This fixture is intentionally constructed with the asserted test-only contract.
  const handler = createChannelWebhookRouteHandler(agent as never)
  const stop = handler.resume({ agentName: "support", webhookState: state })
  cleanups.push(async () => {
    stop()
    await state.disconnect()
    await rm(stateDir, { force: true, recursive: true })
  })
  const send = () => handler(new Request("https://example.com/api/tickets/webhook", {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
  }), "tickets", { agentName: "support", webhookState: state })
  return { send, state }
}

describe("defineChannelTrigger({ durableState: true })", () => {
  it("gives invoke the Channel's State on the webhook route", async () => {
    const { agent, seen } = agentWith(true, () => new Response(null, { status: 204 }))
    const { send, state } = await routeFor(agent)

    expect((await send()).status).toBe(204)
    expect(seen).toHaveBeenCalledOnce()
    expect(seen.mock.calls[0]![0]).toMatchObject({ keyPrefix: expect.stringMatching(/channel-state:$/), state })
  })

  it("gives invoke the Channel's State when the queue replays a delivery", async () => {
    const result = () => ({ input: { prompt: "triage" }, webhook: { concurrencyLimit: 1, deliveryId: "ticket-1" } })
    const { agent, run, seen } = agentWith(true, () => ({
      input: { prompt: "triage" },
      webhook: { concurrencyLimit: 1, deliveryId: "ticket-1", rehydrate: result },
    }))
    const { send } = await routeFor(agent)

    expect((await send()).status).toBe(200)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(seen).toHaveBeenCalledTimes(2)
    // Each trigger call gets its own transaction() closure (#2618) over the same State and key prefix.
    const [first, replayed] = [seen.mock.calls[0]![0]!, seen.mock.calls[1]![0]!]
    expect(replayed.state).toBe(first.state)
    expect(replayed.keyPrefix).toBe(first.keyPrefix)
  })

  it("throws before invoke runs without the Channel's State", async () => {
    const { agent, seen } = agentWith(true, () => ({ input: { prompt: "triage" } }))

    await expect(resolveAgentTriggerInvocation(agent, runtime, "tickets.opened", {})).rejects.toMatchObject({ code: "AGENT_R1005" })
    expect(seen).not.toHaveBeenCalled()
  })

  it("leaves a trigger without durableState free to run without State", async () => {
    const { agent, seen } = agentWith(false, () => ({ input: { prompt: "triage" } }))

    await expect(resolveAgentTriggerInvocation(agent, runtime, "tickets.opened", {})).resolves.toMatchObject({ input: { prompt: "triage" } })
    expect(seen).toHaveBeenCalledWith(undefined)
  })
})

describe("webhooks.stateScope", () => {
  const queued = () => ({ input: { prompt: "triage" }, webhook: { concurrencyLimit: 1, deliveryId: "ticket-1" } })

  async function queuedRoute(webhooks?: { secretToken: false, stateScope?: string }) {
    const { agent, run, seen } = agentWith(true, () => ({ ...queued(), webhook: { ...queued().webhook, rehydrate: queued } }), webhooks)
    const { send, state } = await routeFor(agent)
    const enqueue = vi.spyOn(state, "enqueueWebhookDelivery")
    return { enqueue, run, seen, send }
  }

  it("keeps queued deliveries and Channel State under the declared scope", async () => {
    const { enqueue, run, seen, send } = await queuedRoute({ secretToken: false, stateScope: "webhook:bot-dev:tickets:tickets" })

    expect((await send()).status).toBe(200)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ scope: "webhook:bot-dev:tickets:tickets:" })
    // The route and the queue replay both bind the Channel State under the declared scope.
    expect(seen.mock.calls.map(([channelState]) => channelState?.keyPrefix)).toEqual([
      "webhook:bot-dev:tickets:tickets:channel-state:",
      "webhook:bot-dev:tickets:tickets:channel-state:",
    ])
  })

  it("uses the owner's scope without stateScope", async () => {
    const { enqueue, run, seen, send } = await queuedRoute()

    expect((await send()).status).toBe(200)
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ scope: "webhook:support:tickets:tickets:" })
    expect(seen.mock.calls[0]![0]?.keyPrefix).toBe("webhook:support:tickets:tickets:channel-state:")
  })

  it.each(["", " ", "::", 1])("rejects stateScope %j", async (stateScope) => {
    // SAFETY: The test passes a value that the type rejects, as JavaScript configuration can.
    const { seen, send } = await queuedRoute({ secretToken: false, stateScope: stateScope as string })

    await expect(send()).rejects.toThrow(new TypeError('[vitehub] Webhook registration "tickets" stateScope must be a non-empty string.'))
    expect(seen).not.toHaveBeenCalled()
  })
})
