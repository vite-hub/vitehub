import { createHash, createHmac } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { defineChannel, sendChannelTrigger, stripe, webhook } from "@vite-hub/channels"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineChannelTrigger, ignored, slack, teams } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { createChannelWebhookRouteHandler, namedChannelHosts, registerAgentChannels } from "../src/server/internal.ts"
import { createLibsqlAgentState } from "../src/state/sqlite.ts"

import type { ChannelEvent } from "@vite-hub/channels"

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const secret = "whsec_test"

function stripeHeader(body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`
}

function stripeEvent(id: string, type = "checkout.session.completed") {
  return JSON.stringify({ id, object: "event", type, data: { object: { id: "cs_1", amount_total: 1200 } } })
}

function hostAgent(channel: unknown) {
  // SAFETY: A standalone Channel host gets a Channel from defineChannel(), as the generated registry passes it.
  return defineAgent({ name: "channel-payments", channels: { payments: channel as never }, driver: { run: () => "unused" } })
}

async function routeFor(agent: ReturnType<typeof hostAgent>, options: { queue?: boolean } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "vitehub-channel-definition-"))
  const state = createLibsqlAgentState({ url: `file:${join(stateDir, "state.sqlite")}` })
  // SAFETY: The route handler takes the Agent as the generated registry passes it.
  const handler = createChannelWebhookRouteHandler(agent as never)
  const routeOptions = { agentName: "channel-payments", webhookState: state }
  const stop = options.queue === false ? () => {} : handler.resume(routeOptions)
  cleanups.push(async () => {
    stop()
    await state.disconnect()
    await rm(stateDir, { force: true, recursive: true })
  })
  const send = (body: string, header = stripeHeader(body)) => handler(new Request("https://example.com/api/_vitehub/channels/payments", {
    body,
    headers: { "content-type": "application/json", "stripe-signature": header },
    method: "POST",
  }), "payments", routeOptions)
  return { send }
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe("defineChannel() on the Agent webhook route", () => {
  it("verifies a Stripe webhook, runs the handler once per event ID, and ignores other events", async () => {
    const handler = vi.fn((_event: ChannelEvent, _context: { channel: string }) => undefined)
    const agent = hostAgent(defineChannel({
      adapter: stripe({ secret }),
      on: { "checkout.session.completed": handler },
    }))
    const { send } = await routeFor(agent)

    const body = stripeEvent("evt_1")
    const accepted = await send(body)
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toMatchObject({ accepted: true, queued: true })
    await until(() => handler.mock.calls.length === 1)
    expect(handler.mock.calls[0]![0]).toEqual({
      name: "checkout.session.completed",
      id: "evt_1",
      data: JSON.parse(body),
    })
    expect(handler.mock.calls[0]![1]).toEqual({ channel: "payments" })

    const duplicate = await send(body)
    await expect(duplicate.json()).resolves.toMatchObject({ duplicate: true })

    const other = await send(stripeEvent("evt_2", "invoice.paid"))
    expect(other.status).toBe(200)
    await expect(other.json()).resolves.toMatchObject({ accepted: false, reason: 'no target for event "invoice.paid"' })

    const forged = await send(stripeEvent("evt_3"), stripeHeader("{}"))
    expect(forged.status).toBe(401)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(handler).toHaveBeenCalledOnce()
  }, 20_000)

  it("retries a handler that returns a failed Result", async () => {
    const failure = Object.assign(new Error("queue unavailable"), { code: "QUEUE_SEND_FAILED" })
    const handler = vi.fn()
      .mockResolvedValueOnce([failure, undefined])
      .mockResolvedValue([undefined, { messageId: "m-1" }])
    const agent = hostAgent(defineChannel({ adapter: stripe({ secret }), on: { "checkout.session.completed": handler } }))
    const { send } = await routeFor(agent)

    expect((await send(stripeEvent("evt_retry"))).status).toBe(200)
    await until(() => handler.mock.calls.length === 2, 15_000)
    expect(handler.mock.calls.map(([event]) => (event as ChannelEvent).id)).toEqual(["evt_retry", "evt_retry"])
  }, 20_000)

  it.each([["invoice.paid", "charge.failed"], ["paid", "failed"]])("routes %s and %s to their own triggers and retries the selected task", async (paidEvent, failedEvent) => {
    const paid = vi.fn(async (..._args: unknown[]) => undefined).mockRejectedValueOnce(new Error("retry paid")).mockResolvedValue(undefined)
    const failed = vi.fn(async (..._args: unknown[]) => undefined)
    const prepared = vi.fn()
    const target = (run: typeof paid) => defineChannelTrigger({
      input: {
        "~standard": {
          version: 1,
          vendor: "test",
          validate(value: unknown) {
            // SAFETY: This test sends the Stripe webhook input that the route builds.
            return { value: (value as { payload: { id: string } }).payload }
          },
        },
      },
      tasks: { record: { prepare: prepared, run } },
      invoke: (_context, input: { id: string }) => ({
        task: "record",
        input: { data: input },
        webhook: { deliveryId: input.id, serialize: "payments" },
      }),
    })
    const { send } = await routeFor(hostAgent(defineChannel({
      adapter: stripe({ secret }),
      on: { [paidEvent]: target(paid), [failedEvent]: target(failed) },
    })))

    const body = stripeEvent("evt_paid", paidEvent)
    const accepted = await send(body)
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toMatchObject({ accepted: true, queued: true })
    await until(() => paid.mock.calls.length === 2, 15_000)
    expect(failed).not.toHaveBeenCalled()
    await expect((await send(body)).json()).resolves.toMatchObject({ duplicate: true })

    expect((await send(stripeEvent("evt_failed", failedEvent))).status).toBe(200)
    await until(() => failed.mock.calls.length === 1)
    expect(prepared).toHaveBeenCalledTimes(3)
    expect(paid.mock.calls[0]![1]).toMatchObject({ input: { data: { id: "evt_paid" } } })
    expect(failed.mock.calls[0]![1]).toMatchObject({ input: { data: { id: "evt_failed" } } })
    const other = await send(stripeEvent("evt_other", "customer.created"))
    await expect(other.json()).resolves.toMatchObject({ accepted: false, reason: 'no target for event "customer.created"' })
  }, 20_000)

  it("filters the event of a single trigger target", async () => {
    const invoke = vi.fn(() => ignored("paid"))
    const { send } = await routeFor(hostAgent(defineChannel({
      adapter: stripe({ secret }),
      on: { "invoice.paid": defineChannelTrigger({ invoke }) },
    })))
    await expect((await send(stripeEvent("evt_other", "charge.failed"))).json()).resolves.toMatchObject({ accepted: false })
    expect(invoke).not.toHaveBeenCalled()
    await expect((await send(stripeEvent("evt_paid", "invoice.paid"))).json()).resolves.toMatchObject({ reason: "paid" })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it("runs the handler before the answer without webhook State", async () => {
    const handler = vi.fn(() => { throw new Error("down") })
    const agent = hostAgent(defineChannel({
      adapter: webhook({ signature: "bearer", secret: "token" }),
      on: { webhook: handler },
    }))
    // SAFETY: The route handler takes the Agent as the generated registry passes it.
    const route = createChannelWebhookRouteHandler(agent as never)
    // The host answers 500 for the thrown error, so the provider retries the delivery.
    await expect(route(new Request("https://example.com/hook", {
      body: "{\"flow_run_id\":\"run-1\"}",
      headers: { "authorization": "Bearer token", "content-type": "application/json" },
      method: "POST",
    }), "payments", { agentName: "channel-payments" })).rejects.toThrow("down")
    expect(handler).toHaveBeenCalledWith({ name: "webhook", id: expect.stringMatching(/^[0-9a-f]{64}$/), data: { flow_run_id: "run-1" } }, { channel: "payments" })
  })

  it("keeps triggers next to handlers when they do not take the webhook", async () => {
    const record = defineChannelTrigger({ webhooks: [], invoke: () => ignored("record") })
    const channel = defineChannel({ adapter: webhook({ secret: false }), on: { webhook: () => undefined, record } })
    const agent = hostAgent(channel)
    expect(Object.keys(agent.channels!.payments!.triggers!)).toEqual(["record", "on"])
    expect(agent.channels!.payments!.triggers!.record).toBe(record)

    expect(() => hostAgent(defineChannel({ adapter: webhook({ secret: false }), on: { webhook: () => undefined, record: defineChannelTrigger({ invoke: () => ignored("record") }) } })))
      .toThrow('so the trigger "record" cannot')
  })

  it("passes Agent options and keeps a chat adapter as the Agent Channel", () => {
    const adapter = teams({ adapter: { userName: "Bot" } })
    expect(hostAgent(defineChannel({ adapter })).channels!.payments).toBe(adapter)
    const withInstructions = hostAgent(defineChannel({ adapter: webhook({ secret: false }), instructions: "Triage the failure." })).channels!.payments!
    expect(withInstructions).toMatchObject({ instructions: "Triage the failure.", kind: "webhook", messages: false })
  })

  it("sends through a chat adapter", async () => {
    const postMessage = vi.fn(async () => ({ id: "ts-1", threadId: "slack:C1:" }))
    const channel = slack({ adapter: { postMessage } as never })
    await expect(channel.send("Deploy finished.", { recipient: "slack:C1:" })).resolves.toEqual({ id: "ts-1" })
    expect(postMessage).toHaveBeenCalledWith("slack:C1:", { markdown: "Deploy finished." })
  })

  it("resolves the Channels that an Agent lists by name", () => {
    const adapter = teams({ adapter: { userName: "Bot" } })
    registerAgentChannels({ support: { default: defineChannel({ adapter }) }, payments: defineChannel({ adapter: stripe({ secret }) }) })
    const agent = defineAgent({ name: "support", channels: ["support", "payments"], driver: { run: () => "ok" } })
    expect(agent.channels!.support).toBe(adapter)
    expect(agent.channels!.payments).toMatchObject({ kind: "stripe", messages: false })
    expect(namedChannelHosts({ support: agent })).toEqual({ payments: "support", support: "support" })
    expect(() => namedChannelHosts({ a: agent, b: defineAgent({ name: "b", channels: ["support"], driver: { run: () => "ok" } }) })).toThrow('both list the Channel "support"')
    expect(() => defineAgent({ channels: ["missing"], driver: { run: () => "ok" } })).toThrow('lists the Channel "missing", which is not registered')
  })

  it("starts an on handler and a trigger from code with sendChannelTrigger()", async () => {
    const handler = vi.fn()
    const run = vi.fn()
    const agent = hostAgent(defineChannel({
      adapter: stripe({ secret }),
      on: {
        "checkout.session.completed": handler,
        record: defineChannelTrigger({
          durableState: true,
          webhooks: [],
          tasks: { sync: { run: (_context, { input }) => run(input.data) } },
          invoke: (_context, item: { id: string }) => ({ task: "sync", input: { data: item }, webhook: { deliveryId: `record:${item.id}`, serialize: `record:${item.id}` } }),
        }),
      },
    }))
    await routeFor(agent)

    const event = JSON.parse(stripeEvent("evt_code"))
    await expect(sendChannelTrigger("payments", "checkout.session.completed", event)).resolves.toEqual([undefined, { deliveryId: "evt_code", queued: true }])
    await expect(sendChannelTrigger("payments", "checkout.session.completed", event)).resolves.toEqual([undefined, { deliveryId: "evt_code", queued: false }])
    await expect(sendChannelTrigger("payments", "record", { id: "r1" })).resolves.toEqual([undefined, { deliveryId: "record:r1", queued: true }])
    await until(() => handler.mock.calls.length === 1 && run.mock.calls.length === 1, 15_000)
    expect(handler.mock.calls[0]![0]).toEqual({ name: "checkout.session.completed", id: "evt_code", data: event })
    expect(run).toHaveBeenCalledWith({ id: "r1" })

    const [error] = await sendChannelTrigger("payments", "missing", {})
    expect(error).toMatchObject({ code: "CHANNEL_TRIGGER_FAILED" })
    expect(error?.cause).toHaveProperty("message", expect.stringContaining('has no trigger or `on` handler "missing"'))
  }, 30_000)

  it.each(["code", "webhook"] as const)("shares the body delivery ID when %s admits first", async (first) => {
    const run = vi.fn()
    const agent = hostAgent(defineChannel({
      adapter: webhook({ secret: false }),
      on: {
        webhook: defineChannelTrigger({
          tasks: { sync: { run: (_context, { input }) => run(input.data) } },
          invoke: (_context, input: { payload: { id: string } }) => ({
            task: "sync",
            input: { data: input.payload },
            webhook: { serialize: "orders" },
          }),
        }),
      },
    }))
    const { send } = await routeFor(agent)
    const input = { id: "order_é" }
    const body = JSON.stringify(input)
    const deliveryId = createHash("sha256").update(body).digest("hex")
    const fromCode = (queued: boolean) => expect(sendChannelTrigger("payments", "webhook", input))
      .resolves.toEqual([undefined, { deliveryId, queued }])
    const fromWebhook = async (queued: boolean) => {
      const response = await send(body)
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject(queued ? { queued: true } : { duplicate: true })
    }

    if (first === "code") {
      await fromCode(true)
      await fromWebhook(false)
    }
    else {
      await fromWebhook(true)
      await fromCode(false)
    }
    await fromCode(false)
    await until(() => run.mock.calls.length === 1)
    expect(run).toHaveBeenCalledWith(input)
  }, 20_000)

  it("keeps inherited named Channels through child and grandchild layers", () => {
    registerAgentChannels(Object.fromEntries(["parent", "child", "grandchild"].map(name => [name, defineChannel({ adapter: webhook({ secret: false }) })])))
    const parent = defineAgent({ channels: ["parent"], driver: { run: () => "ok" } })
    const child = defineAgent({ extends: parent, channels: ["child"] })
    const grandchild = defineAgent({ extends: child, channels: ["grandchild"] })
    expect(Object.keys(grandchild.channels!)).toEqual(["parent", "child", "grandchild"])
    expect(namedChannelHosts({ support: grandchild })).toEqual({ parent: "support", child: "support", grandchild: "support" })
    expect(() => namedChannelHosts({ support: grandchild, other: parent })).toThrow('both list the Channel "parent"')
  })

  it("keeps named ownership for merged records and clears it for inline replacements", () => {
    registerAgentChannels({ inherited: defineChannel({ adapter: webhook({ secret: false }) }), added: defineChannel({ adapter: webhook({ secret: false }) }) })
    const parent = defineAgent({ channels: ["inherited"], driver: { run: () => "ok" } })
    const added = defineAgent({ channels: ["added"], driver: { run: () => "ok" } })
    const child = defineAgent({ extends: parent, channels: added.channels })
    expect(namedChannelHosts({ support: child })).toEqual({ inherited: "support", added: "support" })
    const replacement = teams({ adapter: { userName: "Bot" } })
    const inline = defineAgent({ extends: child, channels: { inherited: defineChannel({ adapter: replacement }) } })
    expect(inline.channels!.inherited).toBe(replacement)
    expect(namedChannelHosts({ support: inline })).toEqual({ added: "support" })
  })

  it("keeps named Channels in configured Workspace Agent layers", () => {
    registerAgentChannels({ inherited: defineChannel({ adapter: webhook({ secret: false }) }), added: defineChannel({ adapter: webhook({ secret: false }) }) })
    const preset = defineAgent({
      options: { description: "initial" },
      configure: options => defineAgent({ description: options.description, channels: ["inherited"], workspace: {}, driver: { run: () => "ok" } }),
    })
    const child = defineAgent({ extends: preset, channels: ["added"] })
    const grandchild = defineAgent({ extends: child, options: { description: "updated" } })
    expect(namedChannelHosts({ support: grandchild })).toEqual({ inherited: "support", added: "support" })
    expect(grandchild.__vitehubWorkspaceAgentOptions.description).toBe("updated")
  })

  it.each(["__proto__", "toString", "constructor"])("resolves the prototype-like Channel name %s", name => {
    registerAgentChannels({ [name]: defineChannel({ adapter: webhook({ secret: false }) }) })
    const agent = defineAgent({ channels: [name], driver: { run: () => "ok" } })
    expect(Object.hasOwn(agent.channels!, name)).toBe(true)
    expect(agent.channels![name]).toMatchObject({ kind: "webhook" })
    const hosts = namedChannelHosts({ support: agent })
    expect(Object.hasOwn(hosts, name)).toBe(true)
    expect(hosts[name]).toBe("support")
    expect(hosts.missing).toBeUndefined()
    expect(() => namedChannelHosts({ support: agent, other: agent })).toThrow(`both list the Channel "${name}"`)
  })
})
