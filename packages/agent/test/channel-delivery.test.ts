import { describe, expect, it, vi } from "vitest"

import { openAgentChannelDelivery, readAgentChannelDeliveries, resumeAgentChannelDelivery } from "../src/internal/channel-delivery.ts"

import type { StateAdapter } from "chat"

function stateAdapter(): StateAdapter {
  const values = new Map<string, unknown>()
  const lists = new Map<string, unknown[]>()
  return {
    appendToList: async (key: string, value: unknown, options?: { maxLength?: number }) => {
      const list = [...(lists.get(key) || []), value]
      lists.set(key, options?.maxLength ? list.slice(-options.maxLength) : list)
    },
    get: async (key: string) => (values.get(key) as never) ?? null,
    getList: async (key: string) => [...(lists.get(key) || [])] as never,
    set: async (key: string, value: unknown) => void values.set(key, value),
    setIfNotExists: async (key: string, value: unknown) => {
      if (values.has(key)) return false
      values.set(key, value)
      return true
    },
  } as unknown as StateAdapter
}

describe("Agent Channel delivery journal", () => {
  it("keeps provider retries on one durable, inspectable timeline", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const input = {
      agentName: "support",
      channelId: "discord",
      provider: "discord",
      scope: "channel:42",
      sourceId: "message:7",
    }

    const first = await openAgentChannelDelivery(state, input)
    await first.event({ runId: "run:7", type: "invocation.started" })
    const retry = await openAgentChannelDelivery(state, input)
    await retry.event({ attempt: 2, error: "provider unavailable", type: "retrying" })
    const resumed = await resumeAgentChannelDelivery(state, first.delivery.id)
    await resumed?.event({ messageId: "reply:9", type: "outbound.completed" })
    await resumed?.event({ type: "completed" })

    expect(retry.duplicate).toBe(true)
    expect(retry.delivery.id).toBe(first.delivery.id)
    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({
        agentName: "support",
        id: first.delivery.id,
        provider: "discord",
        sourceId: "message:7",
        events: expect.arrayContaining([
          expect.objectContaining({ type: "received" }),
          expect.objectContaining({ type: "duplicate" }),
          expect.objectContaining({ attempt: 2, type: "retrying" }),
          expect.objectContaining({ messageId: "reply:9", type: "outbound.completed" }),
          expect.objectContaining({ type: "completed" }),
        ]),
      }),
    ])
    info.mockRestore()
  })

  it("surfaces a failed delivery without persisting message content", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const delivery = await openAgentChannelDelivery(state, {
      agentName: "support",
      provider: "github",
      scope: "webhook:support:github",
      sourceId: "delivery-9",
    })

    await delivery.event({ error: "signature mismatch", type: "rejected" })

    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({
        status: "rejected",
        events: expect.arrayContaining([expect.objectContaining({ error: "signature mismatch", type: "rejected" })]),
      }),
    ])
    info.mockRestore()
  })

  it("emits a structured fallback when the durable journal cannot write", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const state = stateAdapter()
    const appendToList = state.appendToList.bind(state)
    state.appendToList = async (key, value, options) => {
      if (key.endsWith(":events")) throw new Error("state unavailable")
      return await appendToList(key, value, options)
    }

    await expect(openAgentChannelDelivery(state, {
      agentName: "support",
      provider: "telegram",
      scope: "chat:support:telegram",
      sourceId: "update-10",
    })).rejects.toThrow("state unavailable")
    expect(error.mock.calls.map(([entry]) => String(entry)).join("\n")).toContain('"event":"journal.failed"')
    error.mockRestore()
  })

  it("repairs the inspection index after a partially failed open", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const appendToList = state.appendToList.bind(state)
    let failIndex = true
    state.appendToList = async (key, value, options) => {
      if (key === "deliveries:index" && failIndex) {
        failIndex = false
        throw new Error("index unavailable")
      }
      await appendToList(key, value, options)
    }
    const input = { agentName: "support", provider: "github", scope: "webhook:support", sourceId: "delivery-10" }

    await expect(openAgentChannelDelivery(state, input)).rejects.toThrow("index unavailable")
    const reopened = await openAgentChannelDelivery(state, input)

    expect(reopened.duplicate).toBe(true)
    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({ id: reopened.delivery.id, sourceId: "delivery-10" }),
    ])
    info.mockRestore()
  })

  it("bounds event-history reads before applying the inspection limit", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    for (const sourceId of ["one", "two", "three"]) {
      await openAgentChannelDelivery(state, { agentName: "support", provider: "github", scope: "webhook:support", sourceId })
    }
    const getList = vi.spyOn(state, "getList")

    await expect(readAgentChannelDeliveries(state, 1)).resolves.toHaveLength(1)

    expect(getList.mock.calls.filter(([key]) => String(key).endsWith(":events"))).toHaveLength(1)
    info.mockRestore()
  })

  it("keeps terminal settlement when a delayed queued event arrives", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const state = stateAdapter()
    const delivery = await openAgentChannelDelivery(state, { agentName: "support", provider: "discord", scope: "chat:support", sourceId: "message-11" })

    await delivery.event({ type: "completed" })
    await delivery.event({ type: "queued" })

    await expect(readAgentChannelDeliveries(state)).resolves.toEqual([
      expect.objectContaining({ status: "completed" }),
    ])
    info.mockRestore()
  })
})
