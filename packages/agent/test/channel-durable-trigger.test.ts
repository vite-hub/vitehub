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

function agentWith(durableState: boolean, invoke: (channelState: AgentChannelStateBinding | undefined) => AgentTriggerInvokeResult) {
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
        webhooks: { secretToken: false },
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
    expect(seen.mock.calls[1]![0]).toEqual(seen.mock.calls[0]![0])
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
