import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineChannel, defineChannelTrigger, ignored } from "../src/channels.ts"
import { defineAgent, runAgentTrigger } from "../src/index.ts"
import { createAgentRuntimeContext } from "../src/runtime/context.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"
import type { AgentTriggerAcceptedInvocation, AgentTriggerPrepareResult, AgentTriggerRunInvokeResult } from "../src/types.ts"

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Ticket = { id: string, kind: "triage" | "mirror" | "plain" }

function ticketsAgent(options: {
  invoke?: (ticket: Ticket) => void
  prepare?: (invocation: AgentTriggerAcceptedInvocation) => AgentTriggerPrepareResult
  taskPrepare?: (input: { prompt?: unknown, data?: unknown }) => unknown
  delayMs?: number
  /** Answer without the webhook queue. */
  inline?: boolean
} = {}) {
  const host = vi.fn(() => "host")
  const triage = vi.fn((context: { input: { data?: unknown, prompt?: unknown }, run?: { runId?: string } }) => ({ data: context.input.data, prompt: context.input.prompt, runId: context.run?.runId }))
  const mirror = vi.fn((input: { data?: unknown }) => input.data)
  const triageAgent = defineAgent({ name: "triage", driver: { run: triage }, runtime: false })
  const agent = defineAgent({
    name: "support",
    channels: {
      tickets: defineChannel("tickets", {
        messages: false,
        triggers: {
          // The webhook route passes the parsed body as `payload`.
          opened: defineChannelTrigger<{ payload: Ticket }>({
            ...(options.prepare ? { prepare: (_context, invocation) => options.prepare!(invocation) } : {}),
            tasks: {
              triage: {
                agent: triageAgent,
                ...(options.taskPrepare
                  ? { prepare: (_context, { input }) => options.taskPrepare!(input) as undefined }
                  : {}),
              },
              mirror: { run: (_context, { input }) => { mirror(input) } },
            },
            invoke(_context, { payload: ticket }): AgentTriggerRunInvokeResult {
              options.invoke?.(ticket)
              return {
                ...(ticket.kind === "plain" ? {} : { task: ticket.kind }),
                input: { data: { id: ticket.id }, prompt: `ticket ${ticket.id}` },
                webhook: options.inline
                  ? { deliveryId: `ticket-${ticket.id}` }
                  : {
                      deliveryId: `ticket-${ticket.id}`,
                      serialize: `ticket:${ticket.id}`,
                      ...(options.delayMs ? { debounce: { delayMs: options.delayMs, key: ticket.id } } : {}),
                    },
              }
            },
          }),
        },
        webhooks: { secretToken: false },
      }),
    },
    driver: { run: host },
    runtime: false,
  })
  return { agent, host, mirror, triage }
}

async function stateFile() {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-channel-tasks-"))
  const state = createLibsqlAgentState({ url: `file:${join(dir, "state.sqlite")}` })
  cleanups.push(async () => {
    await state.disconnect()
    await rm(dir, { force: true, recursive: true })
  })
  return state
}

function serve(agent: ReturnType<typeof ticketsAgent>["agent"], state: Awaited<ReturnType<typeof stateFile>>) {
  // SAFETY: The test Agent satisfies the route contract that the generated handler receives.
  const handler = createChannelWebhookRouteHandler(agent as never)
  const options = { agentName: "support", webhookState: state }
  const stop = handler.resume(options)
  cleanups.push(stop)
  const send = (ticket: Ticket) => handler(new Request("https://example.com/api/_vitehub/agents/support/webhooks/tickets", {
    body: JSON.stringify(ticket),
    headers: { "content-type": "application/json" },
    method: "POST",
  }), "tickets", options)
  return { send, stop }
}

describe("Channel trigger tasks", () => {
  it("stores the task, its Agent and the accepted input before prepare runs", async () => {
    const state = await stateFile()
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    const stored: unknown[] = []
    const taskPrepare = vi.fn(async () => {
      const [scope] = await state.webhookDeliveryScopes()
      stored.push(...(await state.webhookDeliveries(scope ?? "")).map(delivery => delivery.invocation))
      await released
    })
    const { agent, host, triage } = ticketsAgent({ taskPrepare })
    const { send } = serve(agent, state)

    const response = await send({ id: "1", kind: "triage" })
    expect(await response.json()).toMatchObject({ accepted: true, queued: true })
    await vi.waitFor(() => expect(taskPrepare).toHaveBeenCalledOnce())
    expect(stored).toEqual([expect.objectContaining({
      agentName: "triage",
      input: expect.objectContaining({ data: { id: "1" }, prompt: "ticket 1" }),
      task: "triage",
    })])
    expect(triage).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(triage).toHaveBeenCalledOnce())
    expect(triage.mock.results[0]?.value).toMatchObject({ data: { id: "1" }, prompt: "ticket 1", runId: "ticket-1" })
    expect(host).not.toHaveBeenCalled()
  })

  it("runs the stored task after a restart without calling invoke again", async () => {
    const state = await stateFile()
    const firstInvoke = vi.fn()
    const first = ticketsAgent({ delayMs: 1_000, invoke: firstInvoke })
    const firstServer = serve(first.agent, state)

    await firstServer.send({ id: "2", kind: "triage" })
    expect(firstInvoke).toHaveBeenCalledOnce()
    // The process stops before the debounced delivery runs.
    await firstServer.stop()
    expect(first.triage).not.toHaveBeenCalled()

    const invoke = vi.fn()

    const second = ticketsAgent({ invoke })
    serve(second.agent, state)
    await vi.waitFor(() => expect(second.triage).toHaveBeenCalledOnce(), { timeout: 5_000 })
    expect(invoke).not.toHaveBeenCalled()
    expect(second.host).not.toHaveBeenCalled()
  })

  it("runs a task's run function without an Agent Invocation", async () => {
    const state = await stateFile()
    const { agent, host, mirror, triage } = ticketsAgent()
    const { send } = serve(agent, state)

    await send({ id: "3", kind: "mirror" })
    await vi.waitFor(() => expect(mirror).toHaveBeenCalledOnce())
    expect(mirror).toHaveBeenCalledWith(expect.objectContaining({ data: { id: "3" } }))
    expect(host).not.toHaveBeenCalled()
    expect(triage).not.toHaveBeenCalled()
  })

  it("uses the task's prepare instead of the trigger's prepare", async () => {
    const state = await stateFile()
    const prepare = vi.fn()
    const taskPrepare = vi.fn(() => ignored("superseded"))
    const { agent, host, triage } = ticketsAgent({ prepare, taskPrepare })
    const { send } = serve(agent, state)
    const complete = vi.spyOn(state, "completeWebhookDelivery")

    await send({ id: "4", kind: "triage" })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(expect.any(String), "ticket-4", expect.any(String)))
    expect(taskPrepare).toHaveBeenCalledOnce()
    expect(prepare).not.toHaveBeenCalled()
    expect(triage).not.toHaveBeenCalled()
    expect(host).not.toHaveBeenCalled()
  })

  it("runs the trigger's prepare in the queue and starts the owning Agent with its input", async () => {
    const state = await stateFile()
    const prepare = vi.fn(({ input }: AgentTriggerAcceptedInvocation) => ({ ...input, prompt: "prepared" }))
    const { agent, host } = ticketsAgent({ prepare })
    const { send } = serve(agent, state)

    await send({ id: "5", kind: "plain" })
    await vi.waitFor(() => expect(host).toHaveBeenCalledOnce())
    expect(prepare).toHaveBeenCalledOnce()
    expect(host).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ prompt: "prepared" }) }))
  })

  it("retries a delivery whose prepare answers with a 5xx Response", async () => {
    const state = await stateFile()
    let attempts = 0
    const prepare = vi.fn(() => (++attempts === 1 ? Response.json({ accepted: false, ok: false, reason: "not_ready" }, { status: 503 }) : undefined))
    const { agent, host } = ticketsAgent({ prepare })
    const retry = vi.spyOn(state, "retryWebhookDelivery")
    const { send } = serve(agent, state)

    await send({ id: "6", kind: "plain" })
    await vi.waitFor(() => expect(host).toHaveBeenCalledOnce(), { timeout: 10_000 })
    expect(retry).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it("answers an inline webhook with the handled Response of prepare", async () => {
    const state = await stateFile()
    const taskPrepare = vi.fn(() => ignored("superseded"))
    const { agent, triage } = ticketsAgent({ inline: true, taskPrepare })
    const { send } = serve(agent, state)

    const response = await send({ id: "8", kind: "triage" })
    expect(await response.json()).toEqual({ accepted: false, ok: true, reason: "superseded" })
    expect(taskPrepare).toHaveBeenCalledOnce()
    expect(triage).not.toHaveBeenCalled()
  })

  it("runs the selected task when a trigger runs directly", async () => {
    const { agent, host, triage } = ticketsAgent()
    const runtime = { ...createAgentRuntimeContext({ runtime: "unknown", waitUntil: vi.fn() }), capabilities: {} }

    await runAgentTrigger(agent, runtime, "tickets.opened", { payload: { id: "7", kind: "triage" } })
    expect(triage).toHaveBeenCalledOnce()
    expect(host).not.toHaveBeenCalled()
  })

  it("rejects a task that is not declared or declares both agent and run", async () => {
    const runtime = { ...createAgentRuntimeContext({ runtime: "unknown", waitUntil: vi.fn() }), capabilities: {} }
    const channelAgent = (trigger: Parameters<typeof defineChannelTrigger>[0]) => defineAgent({
      channels: { tickets: defineChannel("tickets", { messages: false, triggers: { opened: defineChannelTrigger(trigger) } }) },
      driver: { run: () => "ok" },
      runtime: false,
    })
    await expect(runAgentTrigger(channelAgent({ invoke: () => ({ input: { prompt: "x" }, task: "missing" }) }), runtime, "tickets.opened", {}))
      .rejects.toThrow('Task "missing" is not declared by trigger "tickets.opened".')
    await expect(runAgentTrigger(channelAgent({
      // SAFETY: The types allow both fields. The test checks the runtime guard.
      tasks: { both: { agent: defineAgent({ name: "other", driver: { run: () => "ok" } }), run: () => undefined } },
      invoke: () => ({ input: { prompt: "x" }, task: "both" }),
    }), runtime, "tickets.opened", {})).rejects.toThrow('Task "both" of trigger "tickets.opened" must declare exactly one of agent or run.')
  })
})
